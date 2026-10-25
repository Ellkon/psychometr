import { beforeEach, describe, expect, it } from 'vitest';
import { and, count, eq } from 'drizzle-orm';
import { SecuritySignalListSchema } from '@psychometr/shared';
import { fixture, type Fixture } from '../testing/fixture.js';
import { auditEvents, securitySignals, sessions } from '../db/schema.js';
import { appendAudit } from './audit.js';
import { SecuritySignalService } from './security-signals.js';

/* NFR-2 runtime: spikes of denials and failed sign-ins raise a signal for the administrator. */
let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});

async function deny(times: number) {
  for (let i = 0; i < times; i++) {
    const response = await f.request(
      'GET',
      `/api/patients/${f.patientId}/timeline`,
      f.otherDoctor.accessToken,
    );
    expect(response.statusCode).toBe(403);
  }
}

async function auditCount(action: string): Promise<number> {
  const [row] = await f.db
    .select({ n: count() })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action)));
  return row?.n ?? 0;
}

describe('security signals', () => {
  it('twenty denials within five minutes raise one signal per window', async () => {
    // Test files share one database, so another file may already have raised this window's
    // signal: the test checks "at most one new row" and that a row covers these denials.
    const service = new SecuritySignalService(f.db);
    await deny(20);
    const now = new Date();
    const before = await f.db
      .select()
      .from(securitySignals)
      .where(eq(securitySignals.kind, 'access_denied_spike'));
    await service.check(now);
    await new SecuritySignalService(f.db).check(now);
    const after = await f.db
      .select()
      .from(securitySignals)
      .where(eq(securitySignals.kind, 'access_denied_spike'));
    expect(after.length - before.length).toBeLessThanOrEqual(1);
    expect(after.some((row) => row.eventCount >= 20)).toBe(true);
  });

  it('a series of failed sign-ins raises a signal; the administrator sees and acknowledges it', async () => {
    const now = new Date(Date.now() + 60 * 60_000);
    await f.db.transaction(async (tx) => {
      for (let i = 0; i < 10; i++) await appendAudit(tx, { action: 'auth.failed' }, now);
    });
    expect(await new SecuritySignalService(f.db).check(now)).toBeGreaterThanOrEqual(1);

    const listed = await f.request('GET', '/api/admin/security-signals', f.admin.accessToken);
    expect(listed.statusCode).toBe(200);
    const signal = SecuritySignalListSchema.parse(listed.json<unknown>()).signals.find(
      (item) => item.kind === 'auth_failure_spike' && item.acknowledgedAt === null,
    );
    expect(signal).toBeDefined();
    if (!signal) return;

    const acknowledgedBefore = await auditCount('security.signal_acknowledged');
    const path = `/api/admin/security-signals/${signal.id}/ack`;
    expect((await f.request('POST', path, f.admin.accessToken, {})).statusCode).toBe(200);
    expect((await f.request('POST', path, f.admin.accessToken, {})).statusCode).toBe(200);
    expect(await auditCount('security.signal_acknowledged')).toBe(acknowledgedBefore + 1);
  });

  it('doctors, patients and anonymous callers cannot read or acknowledge signals', async () => {
    const patient = (await f.enroll()).accessToken;
    for (const token of [f.doctor.accessToken, patient]) {
      expect((await f.request('GET', '/api/admin/security-signals', token)).statusCode).toBe(403);
    }
    expect((await f.request('GET', '/api/admin/security-signals')).statusCode).toBe(401);
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect(
      (
        await f.request(
          'POST',
          `/api/admin/security-signals/${unknown}/ack`,
          f.doctor.accessToken,
          {},
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.request(
          'POST',
          `/api/admin/security-signals/${unknown}/ack`,
          f.admin.accessToken,
          {},
        )
      ).statusCode,
    ).toBe(404);
  });

  it('the database refuses deleting a signal and changing it after acknowledgement', async () => {
    const [row] = await f.db
      .insert(securitySignals)
      .values({
        kind: 'access_denied_spike',
        windowStart: new Date(Date.UTC(2000, 0, 1)),
        eventCount: 99,
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();
    const target =
      row ??
      (
        await f.db
          .select()
          .from(securitySignals)
          .where(eq(securitySignals.windowStart, new Date(Date.UTC(2000, 0, 1))))
      )[0];
    if (!target) throw new Error('no signal');
    await expect(
      f.db.delete(securitySignals).where(eq(securitySignals.id, target.id)),
    ).rejects.toThrow();
    await expect(
      f.db.update(securitySignals).set({ eventCount: 1 }).where(eq(securitySignals.id, target.id)),
    ).rejects.toThrow();
  });
});

describe('session revocation is one-way (review D1)', () => {
  it('the runtime role cannot clear revoked_at', async () => {
    const [session] = await f.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, f.doctor.user.id))
      .limit(1);
    if (!session) throw new Error('no session');
    await f.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session.id));
    await expect(
      f.db.update(sessions).set({ revokedAt: null }).where(eq(sessions.id, session.id)),
    ).rejects.toThrow();
  });
});
