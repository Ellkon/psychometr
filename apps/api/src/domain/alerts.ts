/**
 * Critical alerts (FR-8): transactional outbox in PostgreSQL, delivery over WebSocket,
 * acknowledgement by the recipient, and escalation to a reserve doctor (FR-8.3).
 *
 * An alert is raised for every firing of a `critical` rule (content/rules), in the same transaction
 * as the rule evaluation and the answer that caused it, so an alert cannot exist without its source
 * and a rolled-back answer leaves no alert. The text is the rule's own message and suggested
 * action; nothing clinical is written here. Delivery is at-least-once: the client de-duplicates by
 * alert id.
 *
 * Limitation: the socket registry is in memory, so delivery assumes one API instance. Several
 * instances would need PostgreSQL LISTEN/NOTIFY or a shared broker; the outbox rows already hold
 * the state, so only the wake-up path would change.
 */
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { ESCALATION_MINUTES, type Alert, type Principal, type Rule } from '@psychometr/shared';
import type { Database, Transaction } from '../db/client.js';
import { alerts, careTeam, patientIdentity } from '../db/schema.js';
import type { IdentityVault } from '../security/identity.js';
import { assertRole, authorized } from './access.js';
import { appendAudit } from './audit.js';
import { DomainError } from './errors.js';

type AlertRow = typeof alerts.$inferSelect;
type Db = Database | Transaction;

const ESCALATION_MS = ESCALATION_MINUTES * 60_000;
/** A sent but unacknowledged alert is re-sent to a reconnected socket after this delay. */
const RESEND_AFTER_MS = 30_000;
const BATCH = 100;
const MAX_SOCKETS_PER_DOCTOR = 10;
/** How often open sockets are re-checked against their session (revocation, logout, idle). */
const SWEEP_MS = 30_000;
/** Close code for a socket whose session ended; the client refreshes and reconnects (or stops). */
const CLOSE_SESSION_ENDED = 4401;

/**
 * Recipient is still on the patient's care team. Revoking a doctor's assignment must stop their
 * alerts at once, including the patient name inside them (FR-8, S-2). Correlated to alerts row.
 */
const stillAssigned = sql`exists (select 1 from ${careTeam} where ${careTeam.patientId} = ${alerts.patientId} and ${careTeam.practitionerId} = ${alerts.recipientId})`;

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Re-checks the session behind a socket. False means the socket must close (fails closed). */
export type LiveCheck = () => Promise<boolean>;

export interface SocketEntry {
  practitionerId: string;
  socket: SocketLike;
  live: LiveCheck;
}

/** In-memory map of authenticated doctor sockets. */
export class AlertHub {
  private readonly sockets = new Map<string, Map<SocketLike, LiveCheck>>();

  register(practitionerId: string, socket: SocketLike, live: LiveCheck): boolean {
    const set = this.sockets.get(practitionerId) ?? new Map<SocketLike, LiveCheck>();
    if (set.size >= MAX_SOCKETS_PER_DOCTOR) return false;
    set.set(socket, live);
    this.sockets.set(practitionerId, set);
    return true;
  }

  unregister(practitionerId: string, socket: SocketLike): void {
    const set = this.sockets.get(practitionerId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.sockets.delete(practitionerId);
  }

  connected(practitionerId: string): SocketLike[] {
    return [...(this.sockets.get(practitionerId)?.keys() ?? [])];
  }

  entries(): SocketEntry[] {
    const all: SocketEntry[] = [];
    for (const [practitionerId, set] of this.sockets) {
      for (const [socket, live] of set) all.push({ practitionerId, socket, live });
    }
    return all;
  }
}

/** Reserve recipient: the next care-team member in assignment order, never the current recipient. */
export function pickReserve(careTeamInOrder: readonly string[], current: string): string | null {
  return careTeamInOrder.find((id) => id !== current) ?? null;
}

export class AlertService {
  constructor(
    private readonly db: Database,
    private readonly vault: IdentityVault,
    readonly hub: AlertHub = new AlertHub(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Last time open sockets were re-checked; the sweep runs at most every SWEEP_MS. */
  private lastSweep = Number.NEGATIVE_INFINITY;

  /**
   * Called inside the rule-evaluation transaction for a fired rule. Only `critical` rules raise
   * an alert (FR-8.4: hard signals are rare; the rest stays a non-intrusive card).
   */
  async raise(
    tx: Transaction,
    patientId: string,
    evaluationId: string,
    rule: Pick<Rule, 'id' | 'severity' | 'message' | 'suggested_action'>,
    now: Date,
  ): Promise<void> {
    if (rule.severity !== 'critical') return;
    const [primary] = await tx
      .select({ id: careTeam.practitionerId })
      .from(careTeam)
      .where(eq(careTeam.patientId, patientId))
      .orderBy(asc(careTeam.assignedAt), asc(careTeam.practitionerId))
      .limit(1);
    // Every patient is created with a care-team doctor, so this is an invariant. Fail loudly:
    // a safety signal must never be dropped silently.
    if (!primary) throw new Error('Alert recipient missing: patient has no care team');
    const inserted = await tx
      .insert(alerts)
      .values({
        patientId,
        recipientId: primary.id,
        evaluationId,
        ruleId: rule.id,
        severity: 'critical',
        message: rule.message,
        suggestedAction: rule.suggested_action,
        status: 'pending',
        idempotencyKey: `${evaluationId}:${primary.id}`,
        createdAt: now,
        escalateAt: new Date(now.getTime() + ESCALATION_MS),
      })
      .onConflictDoNothing({ target: alerts.idempotencyKey })
      .returning({ id: alerts.id });
    if (inserted.length > 0)
      await appendAudit(
        tx,
        { action: 'alert.created', resourceId: patientId, detail: rule.id },
        now,
      );
  }

  /** Doctor's open alerts (not yet acknowledged), newest first. */
  async list(user: Principal): Promise<{ alerts: Alert[] }> {
    return authorized(this.db, user, async (tx) => {
      assertRole(user, 'doctor');
      const rows = await tx
        .select()
        .from(alerts)
        .where(and(eq(alerts.recipientId, user.id), isNull(alerts.acknowledgedAt), stillAssigned))
        .orderBy(desc(alerts.createdAt))
        .limit(100);
      const views = await this.views(tx, rows);
      await appendAudit(tx, { action: 'alerts.viewed', actorId: user.id }, this.now());
      return { alerts: views };
    });
  }

  /** Acknowledgement by the recipient only. Another doctor gets 404, so existence is not revealed. */
  async ack(user: Principal, alertId: string): Promise<{ ok: true }> {
    return authorized(this.db, user, async (tx) => {
      assertRole(user, 'doctor');
      const [row] = await tx
        .select()
        .from(alerts)
        .where(and(eq(alerts.id, alertId), eq(alerts.recipientId, user.id), stillAssigned));
      if (!row) throw new DomainError(404, 'alert_not_found', 'Алерт не найден');
      if (row.acknowledgedAt) return { ok: true as const };
      const now = this.now();
      const updated = await tx
        .update(alerts)
        .set({ status: 'acknowledged', acknowledgedAt: now, acknowledgedBy: user.id })
        .where(and(eq(alerts.id, alertId), isNull(alerts.acknowledgedAt)))
        .returning({ id: alerts.id });
      // A concurrent acknowledgement won the row lock: one audit record per alert.
      if (updated.length === 0) return { ok: true as const };
      await appendAudit(
        tx,
        {
          action: 'alert.acknowledged',
          actorId: user.id,
          resourceId: row.patientId,
          detail: row.ruleId,
        },
        now,
      );
      return { ok: true as const };
    });
  }

  /** Client confirmed it received the alert over the socket: sent → delivered. */
  async markReceived(practitionerId: string, alertId: string): Promise<void> {
    await this.db
      .update(alerts)
      .set({ status: 'delivered', deliveredAt: this.now() })
      .where(
        and(
          eq(alerts.id, alertId),
          eq(alerts.recipientId, practitionerId),
          eq(alerts.status, 'sent'),
          stillAssigned,
        ),
      );
  }

  /** Sends every open undelivered alert to a socket that has just authenticated. */
  async flushFor(practitionerId: string, socket: SocketLike, now = this.now()): Promise<number> {
    const rows = await this.db
      .select()
      .from(alerts)
      .where(
        and(
          eq(alerts.recipientId, practitionerId),
          isNull(alerts.acknowledgedAt),
          or(eq(alerts.status, 'pending'), eq(alerts.status, 'sent')),
          stillAssigned,
        ),
      )
      .orderBy(asc(alerts.createdAt))
      .limit(BATCH);
    for (const row of rows) await this.deliver(row, [socket], now);
    return rows.length;
  }

  /** One outbox pass: pending alerts, and sent ones whose last attempt is stale. */
  async dispatch(now = this.now()): Promise<number> {
    const staleBefore = new Date(now.getTime() - RESEND_AFTER_MS);
    const rows = await this.db
      .select()
      .from(alerts)
      .where(
        and(
          isNull(alerts.acknowledgedAt),
          stillAssigned,
          or(
            eq(alerts.status, 'pending'),
            and(
              eq(alerts.status, 'sent'),
              or(isNull(alerts.attemptedAt), lte(alerts.attemptedAt, staleBefore)),
            ),
          ),
        ),
      )
      .orderBy(asc(alerts.createdAt))
      .limit(BATCH);
    let attempted = 0;
    for (const row of rows) {
      const sockets = this.hub.connected(row.recipientId);
      if (sockets.length === 0) continue;
      await this.deliver(row, sockets, now);
      attempted++;
    }
    return attempted;
  }

  /**
   * Escalation (FR-8.3): an unacknowledged primary alert whose timer has passed gets a copy for
   * the reserve doctor. The copy is not escalated again. With no reserve, the timer is cleared
   * and the event is audited once; the alert stays open in the doctor's list.
   */
  async escalate(now = this.now()): Promise<number> {
    const due = await this.db
      .select({ id: alerts.id })
      .from(alerts)
      .where(
        and(lte(alerts.escalateAt, now), isNull(alerts.acknowledgedAt), isNull(alerts.escalatedAt)),
      )
      .limit(BATCH);
    let handled = 0;
    for (const { id } of due) {
      const done = await this.db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(alerts)
          .where(eq(alerts.id, id))
          .for('update', { skipLocked: true });
        if (
          !locked ||
          locked.acknowledgedAt ||
          locked.escalatedAt ||
          !locked.escalateAt ||
          locked.escalateAt > now
        )
          return false;
        const team = await tx
          .select({ id: careTeam.practitionerId })
          .from(careTeam)
          .where(eq(careTeam.patientId, locked.patientId))
          .orderBy(asc(careTeam.assignedAt), asc(careTeam.practitionerId));
        const reserve = pickReserve(
          team.map((member) => member.id),
          locked.recipientId,
        );
        if (reserve) {
          await tx
            .insert(alerts)
            .values({
              patientId: locked.patientId,
              recipientId: reserve,
              evaluationId: locked.evaluationId,
              ruleId: locked.ruleId,
              severity: locked.severity,
              message: locked.message,
              suggestedAction: locked.suggestedAction,
              status: 'pending',
              idempotencyKey: `escalation:${locked.id}`,
              escalationOf: locked.id,
              createdAt: now,
            })
            .onConflictDoNothing({ target: alerts.idempotencyKey });
          await tx
            .update(alerts)
            .set({ escalatedAt: now, escalateAt: null })
            .where(eq(alerts.id, locked.id));
          await appendAudit(
            tx,
            { action: 'alert.escalated', resourceId: locked.patientId, detail: locked.ruleId },
            now,
          );
        } else {
          await tx.update(alerts).set({ escalateAt: null }).where(eq(alerts.id, locked.id));
          await appendAudit(
            tx,
            {
              action: 'alert.escalation_unavailable',
              resourceId: locked.patientId,
              detail: locked.ruleId,
            },
            now,
          );
        }
        return true;
      });
      if (done) handled++;
    }
    return handled;
  }

  /** One worker tick: deliver, then escalate. Safe to call repeatedly. */
  async tick(now = this.now()): Promise<{ dispatched: number; escalated: number }> {
    await this.sweepSockets(now);
    const dispatched = await this.dispatch(now);
    const escalated = await this.escalate(now);
    return { dispatched, escalated };
  }

  /**
   * Re-checks every open socket against its session. A revoked, expired, idle or deactivated
   * session closes the socket with 4401. Errors count as "not live": fail closed.
   */
  async sweepSockets(now = this.now()): Promise<number> {
    if (now.getTime() - this.lastSweep < SWEEP_MS) return 0;
    this.lastSweep = now.getTime();
    let closed = 0;
    for (const entry of this.hub.entries()) {
      const live = await entry.live().catch(() => false);
      if (live) continue;
      this.hub.unregister(entry.practitionerId, entry.socket);
      entry.socket.close(CLOSE_SESSION_ENDED, 'session_ended');
      closed++;
    }
    return closed;
  }

  private async deliver(row: AlertRow, sockets: SocketLike[], now: Date): Promise<void> {
    const [view] = await this.views(this.db, [row]);
    const message = JSON.stringify({ type: 'alert', alert: view });
    for (const socket of sockets) {
      try {
        socket.send(message);
      } catch {
        // A dead socket is removed by its own close handler; the row stays open for the next socket.
      }
    }
    await this.db
      .update(alerts)
      .set({
        attemptedAt: now,
        ...(row.status === 'pending' ? { status: 'sent' as const, sentAt: now } : {}),
      })
      .where(eq(alerts.id, row.id));
  }

  /** One identity query per batch, not per alert. */
  private async views(tx: Db, rows: AlertRow[]): Promise<Alert[]> {
    if (rows.length === 0) return [];
    const ids = [...new Set(rows.map((row) => row.patientId))];
    const identities = await tx
      .select()
      .from(patientIdentity)
      .where(inArray(patientIdentity.patientId, ids));
    const names = new Map<string, string>();
    for (const identity of identities) {
      const decrypted = this.vault.decrypt(identity.patientId, identity);
      names.set(identity.patientId, `${decrypted.lastName} ${decrypted.firstName}`);
    }
    return rows.map((row) => {
      const patientName = names.get(row.patientId);
      if (patientName === undefined) throw new Error('Patient identity missing');
      return {
        id: row.id,
        ruleId: row.ruleId,
        severity: 'critical' as const,
        patientId: row.patientId,
        patientName,
        message: row.message,
        suggestedAction: row.suggestedAction,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
        escalatedFrom: row.escalationOf,
      };
    });
  }
}
