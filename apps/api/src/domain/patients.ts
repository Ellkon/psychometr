import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { AuditActionSchema, type PatientIdentity, type Principal } from '@psychometr/shared';
import type { Database } from '../db/client.js';
import {
  alerts,
  auditEvents,
  careTeam,
  patientDevices,
  patientIdentity,
  patientInvites,
  patients,
  practitioners,
  sessions,
  users,
} from '../db/schema.js';
import { hashCredential, newInviteCode, newOpaqueToken, digest } from '../security/credentials.js';
import type { IdentityVault } from '../security/identity.js';
import { appendAudit, verifyAuditChain } from './audit.js';
import { assertCanAccessPatient, assertRole, authorized } from './access.js';
import { DomainError } from './errors.js';

/** Admin directory size. Pagination or search is needed before a clinic grows past this. */
const PRACTITIONER_LIST_LIMIT = 500;

export class PatientService {
  constructor(
    private readonly db: Database,
    private readonly vault: IdentityVault,
    private readonly origin: string,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async create(user: Principal, identity: PatientIdentity) {
    return authorized(this.db, user, async (tx) => {
      const patientId = randomUUID();
      await assertCanAccessPatient(user, patientId, tx, 'create');
      const [account] = await tx.insert(users).values({ role: 'patient' }).returning();
      if (!account) throw new Error('Account insert failed');
      const [patient] = await tx
        .insert(patients)
        .values({ id: patientId, userId: account.id })
        .returning();
      if (!patient) throw new Error('Patient insert failed');
      await tx.insert(careTeam).values({ patientId: patient.id, practitionerId: user.id });
      await assertCanAccessPatient(user, patient.id, tx);
      await tx
        .insert(patientIdentity)
        .values({ patientId: patient.id, ...this.vault.encrypt(patient.id, identity) });
      await appendAudit(
        tx,
        { action: 'patient.created', actorId: user.id, resourceId: patient.id },
        this.now(),
      );
      return { id: patient.id };
    });
  }
  async list(user: Principal, offset: number, limit: number) {
    return authorized(this.db, user, async (tx) => {
      assertRole(user, 'doctor');
      const rows = await tx
        .select({ id: careTeam.patientId })
        .from(careTeam)
        .where(eq(careTeam.practitionerId, user.id))
        .orderBy(asc(careTeam.patientId))
        .offset(offset)
        .limit(limit);
      const result: { id: string; createdAt: string }[] = [];
      for (const row of rows) {
        await assertCanAccessPatient(user, row.id, tx);
        const [patient] = await tx.select().from(patients).where(eq(patients.id, row.id));
        if (patient) result.push({ id: patient.id, createdAt: patient.createdAt.toISOString() });
      }
      for (const patient of result)
        await appendAudit(
          tx,
          { action: 'patient.viewed', actorId: user.id, resourceId: patient.id },
          this.now(),
        );
      return { patients: result };
    });
  }
  async read(user: Principal, patientId: string) {
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx);
        const [identity] = await tx
          .select()
          .from(patientIdentity)
          .where(eq(patientIdentity.patientId, patientId));
        if (!identity) throw new DomainError(404, 'not_found', 'Пациент не найден');
        const decrypted = this.vault.decrypt(patientId, identity);
        await appendAudit(
          tx,
          { action: 'patient.viewed', actorId: user.id, resourceId: patientId },
          this.now(),
        );
        return { id: patientId, identity: decrypted };
      },
      patientId,
    );
  }
  async updateIdentity(user: Principal, patientId: string, value: PatientIdentity) {
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx);
        assertRole(user, 'doctor');
        await tx
          .update(patientIdentity)
          .set(this.vault.encrypt(patientId, value))
          .where(eq(patientIdentity.patientId, patientId));
        await appendAudit(
          tx,
          { action: 'patient.identity_updated', actorId: user.id, resourceId: patientId },
          this.now(),
        );
        return { ok: true as const };
      },
      patientId,
    );
  }
  async createInvite(user: Principal, patientId: string) {
    // argon2 runs before the transaction: appendAudit holds a global advisory
    // lock, and hashing under it would stall every audit write in the system.
    const token = newOpaqueToken(),
      code = newInviteCode();
    const codeHash = await hashCredential(code);
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx);
        assertRole(user, 'doctor');
        const [patient] = await tx.select().from(patients).where(eq(patients.id, patientId));
        if (!patient) throw new DomainError(404, 'not_found', 'Пациент не найден');
        const now = this.now();
        const revoked = await tx
          .update(patientInvites)
          .set({ status: 'revoked' })
          .where(and(eq(patientInvites.patientId, patientId), eq(patientInvites.status, 'pending')))
          .returning({ id: patientInvites.id });
        if (revoked.length)
          await appendAudit(
            tx,
            { action: 'invite.revoked', actorId: user.id, resourceId: patientId },
            now,
          );
        const expiresAt = new Date(now.getTime() + 72 * 60 * 60 * 1000);
        const [invite] = await tx
          .insert(patientInvites)
          .values({
            patientId,
            userId: patient.userId,
            createdBy: user.id,
            tokenHash: digest(token),
            codeHash,
            expiresAt,
          })
          .returning({ id: patientInvites.id });
        if (!invite) throw new Error('Invite insert failed');
        await appendAudit(
          tx,
          { action: 'invite.created', actorId: user.id, resourceId: patientId },
          now,
        );
        return {
          id: invite.id,
          url: `${this.origin}/i/${token}`,
          code,
          expiresAt: expiresAt.toISOString(),
        };
      },
      patientId,
    );
  }
  async invites(user: Principal, patientId: string) {
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx);
        assertRole(user, 'doctor');
        const rows = await tx
          .select({
            id: patientInvites.id,
            status: patientInvites.status,
            attempts: patientInvites.attempts,
            expiresAt: patientInvites.expiresAt,
            createdAt: patientInvites.createdAt,
            usedAt: patientInvites.usedAt,
          })
          .from(patientInvites)
          .where(eq(patientInvites.patientId, patientId))
          .orderBy(desc(patientInvites.createdAt))
          .limit(20);
        return {
          invites: rows.map((row) => ({
            ...row,
            status:
              row.status === 'pending' && row.expiresAt <= this.now()
                ? ('expired' as const)
                : row.status,
            expiresAt: row.expiresAt.toISOString(),
            createdAt: row.createdAt.toISOString(),
            usedAt: row.usedAt?.toISOString() ?? null,
          })),
        };
      },
      patientId,
    );
  }
  async revokeSessions(user: Principal, patientId: string) {
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx);
        assertRole(user, 'doctor');
        const [patient] = await tx.select().from(patients).where(eq(patients.id, patientId));
        if (!patient) throw new DomainError(404, 'not_found', 'Пациент не найден');
        await tx.select().from(users).where(eq(users.id, patient.userId)).for('update');
        const now = this.now();
        await tx
          .update(sessions)
          .set({ revokedAt: now })
          .where(and(eq(sessions.userId, patient.userId), isNull(sessions.revokedAt)));
        await tx
          .update(patientDevices)
          .set({ revokedAt: now })
          .where(and(eq(patientDevices.userId, patient.userId), isNull(patientDevices.revokedAt)));
        await tx
          .update(patientInvites)
          .set({ status: 'revoked' })
          .where(
            and(eq(patientInvites.patientId, patientId), eq(patientInvites.status, 'pending')),
          );
        await appendAudit(
          tx,
          { action: 'sessions.revoked', actorId: user.id, resourceId: patientId },
          now,
        );
        return { ok: true as const };
      },
      patientId,
    );
  }
  async createPractitioner(user: Principal, email: string, password: string) {
    return authorized(this.db, user, async (tx) => {
      assertRole(user, 'admin');
      const [account] = await tx
        .insert(users)
        .values({ role: 'doctor', email, credentialHash: await hashCredential(password) })
        .onConflictDoNothing()
        .returning();
      if (!account) throw new DomainError(409, 'account_exists', 'Учётная запись уже существует');
      await tx.insert(practitioners).values({ userId: account.id });
      await appendAudit(
        tx,
        { action: 'staff.created', actorId: user.id, resourceId: account.id },
        this.now(),
      );
      return { id: account.id };
    });
  }
  async listPractitioners(user: Principal) {
    return authorized(this.db, user, async (tx) => {
      assertRole(user, 'admin');
      const rows = await tx
        .select({ id: users.id, email: users.email })
        .from(practitioners)
        .innerJoin(users, eq(users.id, practitioners.userId))
        .where(eq(users.active, true))
        // Newest first and a deterministic order: an unordered cut hid arbitrary doctors.
        .orderBy(desc(users.createdAt), asc(users.id))
        .limit(PRACTITIONER_LIST_LIMIT);
      return {
        practitioners: rows.flatMap((row) => (row.email ? [{ id: row.id, email: row.email }] : [])),
      };
    });
  }
  async changeCareTeam(
    user: Principal,
    patientId: string,
    practitionerId: string,
    remove: boolean,
  ) {
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx, 'assignment');
        const [patient] = await tx.select().from(patients).where(eq(patients.id, patientId));
        const [doctor] = await tx
          .select()
          .from(practitioners)
          .where(eq(practitioners.userId, practitionerId));
        if (!patient || !doctor)
          throw new DomainError(404, 'not_found', 'Пациент или врач не найден');
        if (remove) {
          // A patient always keeps a doctor: critical alerts need a recipient, and an item-9
          // answer must never fail for lack of one. Assign the new doctor first, then remove.
          const team = await tx
            .select({ id: careTeam.practitionerId })
            .from(careTeam)
            .where(eq(careTeam.patientId, patientId));
          if (team.length <= 1 && team.some((member) => member.id === practitionerId))
            throw new DomainError(
              409,
              'last_doctor',
              'Нельзя снять единственного врача: сначала назначьте другого',
            );
          await tx
            .delete(careTeam)
            .where(
              and(eq(careTeam.patientId, patientId), eq(careTeam.practitionerId, practitionerId)),
            );
          // Open alerts of the removed doctor go to the rest of the care team at the next worker
          // tick instead of waiting out the escalation timer (FR-8.3).
          await tx
            .update(alerts)
            .set({ escalateAt: this.now() })
            .where(
              and(
                eq(alerts.patientId, patientId),
                eq(alerts.recipientId, practitionerId),
                isNull(alerts.acknowledgedAt),
                isNull(alerts.escalatedAt),
              ),
            );
          await tx
            .update(patientInvites)
            .set({ status: 'revoked' })
            .where(
              and(
                eq(patientInvites.patientId, patientId),
                eq(patientInvites.createdBy, practitionerId),
                eq(patientInvites.status, 'pending'),
              ),
            );
        } else
          await tx.insert(careTeam).values({ patientId, practitionerId }).onConflictDoNothing();
        await appendAudit(
          tx,
          { action: 'care_team.changed', actorId: user.id, resourceId: patientId },
          this.now(),
        );
        return { ok: true as const };
      },
      patientId,
    );
  }
  async audit(user: Principal, offset: number, limit: number) {
    return authorized(this.db, user, async (tx) => {
      assertRole(user, 'admin');
      const rows = await tx
        .select()
        .from(auditEvents)
        .orderBy(asc(auditEvents.sequence))
        .offset(offset)
        .limit(limit);
      await appendAudit(tx, { action: 'audit.viewed', actorId: user.id }, this.now());
      return {
        events: rows.map((row) => ({
          ...row,
          action: AuditActionSchema.parse(row.action),
          occurredAt: row.occurredAt.toISOString(),
        })),
      };
    });
  }
  async verifyAudit(user: Principal) {
    return authorized(this.db, user, async (tx) => {
      assertRole(user, 'admin');
      // A consistent prefix while new events may be appended concurrently.
      await tx.execute(sql`select pg_advisory_xact_lock(51982731)`);
      const rows = await tx.select().from(auditEvents).orderBy(asc(auditEvents.sequence));
      const result = { valid: verifyAuditChain(rows), checked: rows.length };
      await appendAudit(tx, { action: 'audit.viewed', actorId: user.id }, this.now());
      return result;
    });
  }
}
