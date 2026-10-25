/**
 * Runtime anomaly detection (NFR-2): the worker counts recent access denials and failed
 * sign-ins in the audit log and raises one signal per kind and window for the administrator.
 * The audit log is the source, so every instance of the API sees the same counts.
 */
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import {
  ACCESS_DENIED_THRESHOLD,
  AUTH_FAILURE_THRESHOLD,
  SECURITY_WINDOW_MINUTES,
  type Principal,
  type SecuritySignal,
  type SecuritySignalKind,
} from '@psychometr/shared';
import type { Database } from '../db/client.js';
import { auditEvents, securitySignals } from '../db/schema.js';
import { appendAudit } from './audit.js';
import { assertRole, authorized } from './access.js';
import { DomainError } from './errors.js';

const WINDOW_MS = SECURITY_WINDOW_MINUTES * 60_000;
/** The check reads the audit log; once every 30 seconds is enough for a 5-minute window. */
const CHECK_EVERY_MS = 30_000;

const RULES: { kind: SecuritySignalKind; actions: string[]; threshold: number }[] = [
  {
    // Object-level denials only: auth.denied also counts routine expired tokens, which would
    // keep the signal on for any busy clinic.
    kind: 'access_denied_spike',
    actions: ['access.denied'],
    threshold: ACCESS_DENIED_THRESHOLD,
  },
  {
    kind: 'auth_failure_spike',
    actions: ['auth.failed', 'auth.locked', 'invite.failed', 'invite.blocked'],
    threshold: AUTH_FAILURE_THRESHOLD,
  },
];

type SignalRow = typeof securitySignals.$inferSelect;

const view = (row: SignalRow): SecuritySignal => ({
  id: row.id,
  kind: row.kind,
  windowStart: row.windowStart.toISOString(),
  eventCount: row.eventCount,
  createdAt: row.createdAt.toISOString(),
  acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
});

export class SecuritySignalService {
  private lastCheck = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Counts events of each kind over the last window. At or above the threshold, a signal is
   * stored for the current window bucket; a repeat in the same bucket is a no-op.
   */
  async check(now = this.now()): Promise<number> {
    if (now.getTime() - this.lastCheck < CHECK_EVERY_MS) return 0;
    this.lastCheck = now.getTime();
    const since = new Date(now.getTime() - WINDOW_MS);
    const bucket = new Date(Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS);
    let raised = 0;
    for (const rule of RULES) {
      const [counted] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(auditEvents)
        .where(and(inArray(auditEvents.action, rule.actions), gte(auditEvents.occurredAt, since)));
      const count = counted?.count ?? 0;
      if (count < rule.threshold) continue;
      const created = await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(securitySignals)
          .values({ kind: rule.kind, windowStart: bucket, eventCount: count, createdAt: now })
          .onConflictDoNothing()
          .returning({ id: securitySignals.id });
        if (inserted.length === 0) return false;
        await appendAudit(tx, { action: 'security.signal_raised', detail: rule.kind }, now);
        return true;
      });
      if (created) raised++;
    }
    return raised;
  }

  /** Open signals first, then the latest acknowledged ones. Administrator only. */
  async list(user: Principal): Promise<{ signals: SecuritySignal[] }> {
    return authorized(this.db, user, async (tx) => {
      assertRole(user, 'admin');
      const rows = await tx
        .select()
        .from(securitySignals)
        .orderBy(
          sql`${securitySignals.acknowledgedAt} is not null`,
          desc(securitySignals.createdAt),
        )
        .limit(50);
      return { signals: rows.map(view) };
    });
  }

  async acknowledge(user: Principal, signalId: string): Promise<{ ok: true }> {
    return authorized(this.db, user, async (tx) => {
      assertRole(user, 'admin');
      const now = this.now();
      const updated = await tx
        .update(securitySignals)
        .set({ acknowledgedAt: now, acknowledgedBy: user.id })
        .where(and(eq(securitySignals.id, signalId), isNull(securitySignals.acknowledgedAt)))
        .returning({ kind: securitySignals.kind });
      const [row] = updated;
      if (!row) {
        const [existing] = await tx
          .select({ id: securitySignals.id })
          .from(securitySignals)
          .where(eq(securitySignals.id, signalId));
        if (!existing) throw new DomainError(404, 'signal_not_found', 'Сигнал не найден');
        return { ok: true as const };
      }
      await appendAudit(
        tx,
        { action: 'security.signal_acknowledged', actorId: user.id, detail: row.kind },
        now,
      );
      return { ok: true as const };
    });
  }
}
