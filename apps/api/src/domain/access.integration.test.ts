import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  AuthResponseSchema,
  InviteListSchema,
  PatientListSchema,
  PatientRecordSchema,
  PractitionerListSchema,
} from '@psychometr/shared';
import { fixture, TEST_CONSENT, TEST_IDENTITY, type Fixture } from '../testing/fixture.js';
import {
  auditEvents,
  consents,
  patientDevices,
  patientIdentity,
  patientInvites,
  refreshTokens,
  sessions,
  users,
} from '../db/schema.js';
import { DEVICE_COOKIE, REFRESH_COOKIE } from '../routes/access.js';
import { digest, newInviteCode, newOpaqueToken } from '../security/credentials.js';
import { appendAudit, verifyAuditChain } from './audit.js';
import { IDLE_MS, SESSION_MS } from './auth.js';

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
const wrongCode = (code: string) => ((Number(code) + 1) % 1_000_000).toString().padStart(6, '0');

const patientRoutes = [
  { method: 'GET', suffix: '', ownPatient: true, expected: 200 },
  { method: 'PATCH', suffix: '/identity', ownPatient: false, expected: 200 },
  { method: 'POST', suffix: '/invites', ownPatient: false, expected: 201 },
  { method: 'GET', suffix: '/invites', ownPatient: false, expected: 200 },
  { method: 'POST', suffix: '/sessions/revoke', ownPatient: false, expected: 200 },
] as const;

describe.each(patientRoutes)('IDOR matrix: $method /patients/:patientId$suffix', (route) => {
  it.each(['own doctor', 'other doctor', 'own patient', 'other patient', 'admin'] as const)(
    '%s has only the intended permissions',
    async (role) => {
      let token: string;
      if (role === 'own doctor') token = f.doctor.accessToken;
      else if (role === 'other doctor') token = f.otherDoctor.accessToken;
      else if (role === 'admin') token = f.admin.accessToken;
      else if (role === 'own patient') token = (await f.enroll()).accessToken;
      else token = (await f.enroll(f.otherPatientId, f.otherDoctor.accessToken)).accessToken;
      const allowed = role === 'own doctor' || (role === 'own patient' && route.ownPatient);
      const body =
        route.method === 'PATCH' ? TEST_IDENTITY : route.method === 'POST' ? {} : undefined;
      const response = await f.request(
        route.method,
        `/api/patients/${f.patientId}${route.suffix}`,
        token,
        body,
      );
      expect(response.statusCode).toBe(allowed ? route.expected : 403);
      if (!allowed) {
        expect(response.body).not.toContain(TEST_IDENTITY.firstName);
        const denials = await f.db
          .select()
          .from(auditEvents)
          .where(
            and(eq(auditEvents.resourceId, f.patientId), eq(auditEvents.action, 'access.denied')),
          );
        expect(denials.length).toBeGreaterThan(0);
      }
    },
  );
});

it('does not enumerate foreign and nonexistent patient UUIDs', async () => {
  const foreign = await f.request('GET', `/api/patients/${f.otherPatientId}`, f.doctor.accessToken);
  const nonexistent = await f.request('GET', `/api/patients/${randomUUID()}`, f.doctor.accessToken);
  expect(foreign.statusCode).toBe(403);
  expect(nonexistent.statusCode).toBe(403);
  expect(nonexistent.body).toBe(foreign.body);
});
it('does not let anonymous callers read data or callers mass-assign role/owner fields', async () => {
  expect((await f.request('GET', `/api/patients/${f.patientId}`)).statusCode).toBe(401);
  expect(
    (await f.request('POST', '/api/patients', f.admin.accessToken, { identity: TEST_IDENTITY }))
      .statusCode,
  ).toBe(403);
  expect(
    (
      await f.request('POST', '/api/patients', f.doctor.accessToken, {
        identity: TEST_IDENTITY,
        role: 'admin',
        userId: f.admin.user.id,
      })
    ).statusCode,
  ).toBe(400);
});
it('lists only assigned patient UUIDs and decrypts identity only behind access checks', async () => {
  const listing = await f.request('GET', '/api/patients', f.doctor.accessToken);
  expect(PatientListSchema.parse(listing.json<unknown>()).patients.map((row) => row.id)).toEqual([
    f.patientId,
  ]);
  const response = await f.request('GET', `/api/patients/${f.patientId}`, f.doctor.accessToken);
  expect(PatientRecordSchema.parse(response.json<unknown>()).identity).toEqual(TEST_IDENTITY);
  const [stored] = await f.db
    .select()
    .from(patientIdentity)
    .where(eq(patientIdentity.patientId, f.patientId));
  expect(stored).toBeDefined();
  expect(JSON.stringify(stored)).not.toContain(TEST_IDENTITY.firstName);
  expect(stored?.nonce).toHaveLength(12);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(
    (
      await f.request(
        'PATCH',
        `/api/patients/${f.patientId.toUpperCase()}/identity`,
        f.doctor.accessToken,
        TEST_IDENTITY,
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (await f.request('GET', `/api/patients/${f.patientId}`, f.doctor.accessToken)).statusCode,
  ).toBe(200);
});

it('allows admin assignment without giving admin access to identity, then revokes doctor access immediately', async () => {
  const directory = await f.request('GET', '/api/admin/practitioners', f.admin.accessToken);
  expect(directory.statusCode).toBe(200);
  expect(
    PractitionerListSchema.parse(directory.json<unknown>()).practitioners.some(
      (doctor) => doctor.id === f.doctor.user.id,
    ),
  ).toBe(true);
  const path = `/api/admin/care-team/${f.patientId}`;
  expect(
    (await f.request('POST', path, f.doctor.accessToken, { practitionerId: f.otherDoctor.user.id }))
      .statusCode,
  ).toBe(403);
  expect(
    (await f.request('POST', path, f.admin.accessToken, { practitionerId: f.otherDoctor.user.id }))
      .statusCode,
  ).toBe(200);
  expect(
    (await f.request('GET', `/api/patients/${f.patientId}`, f.otherDoctor.accessToken)).statusCode,
  ).toBe(200);
  expect(
    (await f.request('GET', `/api/patients/${f.patientId}`, f.admin.accessToken)).statusCode,
  ).toBe(403);
  expect(
    (await f.request('DELETE', `${path}/${f.otherDoctor.user.id}`, f.doctor.accessToken))
      .statusCode,
  ).toBe(403);
  expect(
    (await f.request('DELETE', `${path}/${f.otherDoctor.user.id}`, f.admin.accessToken)).statusCode,
  ).toBe(200);
  expect(
    (await f.request('GET', `/api/patients/${f.patientId}`, f.otherDoctor.accessToken)).statusCode,
  ).toBe(403);
});
it('prevents patients from changing care-team assignments or creating a practitioner', async () => {
  const patient = await f.enroll();
  expect(
    (
      await f.request('POST', `/api/admin/care-team/${f.otherPatientId}`, patient.accessToken, {
        practitionerId: f.doctor.user.id,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await f.request(
        'DELETE',
        `/api/admin/care-team/${f.otherPatientId}/${f.otherDoctor.user.id}`,
        patient.accessToken,
      )
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await f.request('POST', '/api/admin/practitioners', patient.accessToken, {
        email: `${randomUUID()}@example.test`,
        password: newOpaqueToken(),
      })
    ).statusCode,
  ).toBe(403);
});

it('stores only invitation hashes, returns secret material once, and records consent and a bound device', async () => {
  const patient = await f.enroll();
  const [invite] = await f.db
    .select()
    .from(patientInvites)
    .where(eq(patientInvites.id, patient.invitation.id));
  expect(invite?.tokenHash).toBe(digest(patient.invitation.token));
  expect(invite?.codeHash).toMatch(/^\$argon2id\$/);
  expect(invite?.status).toBe('used');
  const statuses = await f.request(
    'GET',
    `/api/patients/${f.patientId}/invites`,
    f.doctor.accessToken,
  );
  expect(InviteListSchema.parse(statuses.json<unknown>()).invites[0]?.status).toBe('used');
  expect(statuses.body).not.toContain(patient.invitation.token);
  expect(statuses.body).not.toContain(patient.invitation.code);
  const [consent] = await f.db.select().from(consents).where(eq(consents.patientId, f.patientId));
  expect(consent?.version).toBe(TEST_CONSENT.version);
  expect(consent?.textHash).toBe(digest(TEST_CONSENT.text));
  expect(consent?.ipCiphertext.toString()).not.toContain('127.0.0.1');
  const [account] = await f.db.select().from(users).where(eq(users.id, patient.user.id));
  expect(account?.credentialHash).toMatch(/^\$argon2id\$/);
  expect(patient.raw.headers['set-cookie']).toBeDefined();
  for (const cookie of patient.raw.cookies) {
    expect(cookie.secure).toBe(true);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite?.toLowerCase()).toBe('strict');
    expect(cookie.path).toBe('/');
  }
});
it('rejects repeat redemption, stale consent, and attempts to choose another patient', async () => {
  const patient = await f.enroll();
  const input = {
    token: patient.invitation.token,
    code: patient.invitation.code,
    personalCode: patient.personalCode,
    consentVersion: TEST_CONSENT.version,
    consentAccepted: true,
  };
  expect(
    (
      await f.request('POST', '/api/auth/invites/accept', undefined, {
        ...input,
        patientId: f.otherPatientId,
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await f.request('POST', '/api/auth/invites/accept', undefined, {
        ...input,
        consentVersion: 'outdated',
      })
    ).statusCode,
  ).toBe(409);
  expect((await f.request('POST', '/api/auth/invites/accept', undefined, input)).statusCode).toBe(
    401,
  );
  const devices = await f.db
    .select()
    .from(patientDevices)
    .where(eq(patientDevices.userId, patient.user.id));
  expect(devices).toHaveLength(1);
});
it('fails closed without an approved consent document', async () => {
  await f.close();
  f = await fixture(false);
  const invitation = await f.invite();
  expect((await f.request('GET', '/api/auth/consent')).statusCode).toBe(503);
  expect(
    (
      await f.request('POST', '/api/auth/invites/accept', undefined, {
        token: invitation.token,
        code: invitation.code,
        personalCode: newInviteCode(),
        consentVersion: TEST_CONSENT.version,
        consentAccepted: true,
      })
    ).statusCode,
  ).toBe(503);
  const [row] = await f.db
    .select()
    .from(patientInvites)
    .where(eq(patientInvites.id, invitation.id));
  expect(row?.status).toBe('pending');
});
it('blocks an invite after five concurrent wrong codes without losing increments', async () => {
  const invite = await f.invite();
  const responses = await Promise.all(
    Array.from({ length: 5 }, () =>
      f.request('POST', '/api/auth/invites/accept', undefined, {
        token: invite.token,
        code: wrongCode(invite.code),
        personalCode: newInviteCode(),
        consentVersion: TEST_CONSENT.version,
        consentAccepted: true,
      }),
    ),
  );
  expect(responses.every((r) => r.statusCode === 401)).toBe(true);
  const [stored] = await f.db.select().from(patientInvites).where(eq(patientInvites.id, invite.id));
  expect(stored?.attempts).toBe(5);
  expect(stored?.status).toBe('blocked');
  expect(
    (
      await f.request('POST', '/api/auth/invites/accept', undefined, {
        token: invite.token,
        code: invite.code,
        personalCode: newInviteCode(),
        consentVersion: TEST_CONSENT.version,
        consentAccepted: true,
      })
    ).statusCode,
  ).toBe(429);
});
it('consumes a valid invite only once under concurrent requests', async () => {
  const invite = await f.invite(),
    personalCode = newInviteCode();
  const responses = await Promise.all(
    Array.from({ length: 4 }, () =>
      f.request('POST', '/api/auth/invites/accept', undefined, {
        token: invite.token,
        code: invite.code,
        personalCode,
        consentVersion: TEST_CONSENT.version,
        consentAccepted: true,
      }),
    ),
  );
  expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);
  expect(responses.filter((r) => r.statusCode === 401)).toHaveLength(3);
});
it('expires invites at 72 hours and revokes old invites on reissue', async () => {
  const old = await f.invite(),
    current = await f.invite();
  const data = {
    code: old.code,
    token: old.token,
    personalCode: newInviteCode(),
    consentVersion: TEST_CONSENT.version,
    consentAccepted: true,
  };
  expect((await f.request('POST', '/api/auth/invites/accept', undefined, data)).statusCode).toBe(
    401,
  );
  f.advance(72 * 60 * 60 * 1000 + 1);
  expect(
    (
      await f.request('POST', '/api/auth/invites/accept', undefined, {
        ...data,
        token: current.token,
        code: current.code,
      })
    ).statusCode,
  ).toBe(401);
  const [row] = await f.db.select().from(patientInvites).where(eq(patientInvites.id, current.id));
  expect(row?.status).toBe('expired');
});
it('requires the personal code on a bound device, never on an arbitrary new device', async () => {
  const patient = await f.enroll();
  await f.request('POST', '/api/auth/logout', undefined, {}, { [REFRESH_COOKIE]: patient.refresh });
  expect(
    (
      await f.request('POST', '/api/auth/patient/login', undefined, {
        personalCode: patient.personalCode,
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await f.request(
        'POST',
        '/api/auth/patient/login',
        undefined,
        { personalCode: wrongCode(patient.personalCode) },
        { [DEVICE_COOKIE]: patient.device },
      )
    ).statusCode,
  ).toBe(401);
  const response = await f.request(
    'POST',
    '/api/auth/patient/login',
    undefined,
    { personalCode: patient.personalCode },
    { [DEVICE_COOKIE]: patient.device },
  );
  expect(response.statusCode).toBe(200);
  expect(AuthResponseSchema.parse(response.json<unknown>()).user.id).toBe(patient.user.id);
});
it('a fresh invite cannot overwrite the personal code of an existing patient', async () => {
  const patient = await f.enroll(),
    invite = await f.invite();
  expect(
    (
      await f.request('POST', '/api/auth/invites/accept', undefined, {
        token: invite.token,
        code: invite.code,
        personalCode: wrongCode(patient.personalCode),
        consentVersion: TEST_CONSENT.version,
        consentAccepted: true,
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await f.request('POST', '/api/auth/invites/accept', undefined, {
        token: invite.token,
        code: invite.code,
        personalCode: patient.personalCode,
        consentVersion: TEST_CONSENT.version,
        consentAccepted: true,
      })
    ).statusCode,
  ).toBe(200);
});

it('locks staff credentials after five failures and permits login after the lock expires', async () => {
  for (let attempt = 0; attempt < 5; attempt += 1)
    expect(
      (
        await f.request('POST', '/api/auth/login', undefined, {
          email: f.doctor.email,
          password: newOpaqueToken(),
        })
      ).statusCode,
    ).toBe(401);
  expect(
    (
      await f.request('POST', '/api/auth/login', undefined, {
        email: f.doctor.email,
        password: f.password,
      })
    ).statusCode,
  ).toBe(401);
  const [user] = await f.db.select().from(users).where(eq(users.id, f.doctor.user.id));
  expect(user?.failedAttempts).toBe(5);
  expect(user?.lockedUntil).not.toBeNull();
  f.advance(15 * 60 * 1000 + 1);
  expect(
    (
      await f.request('POST', '/api/auth/login', undefined, {
        email: f.doctor.email,
        password: f.password,
      })
    ).statusCode,
  ).toBe(200);
});
it('uses the same public error for wrong and unknown accounts and enforces an IP rate limit', async () => {
  const known = await f.request('POST', '/api/auth/login', undefined, {
    email: f.doctor.email,
    password: newOpaqueToken(),
  });
  const unknown = await f.request('POST', '/api/auth/login', undefined, {
    email: `${randomUUID()}@example.test`,
    password: newOpaqueToken(),
  });
  expect(known.body).toBe(unknown.body);
  const responses = await Promise.all(
    Array.from({ length: 12 }, () =>
      f.request('POST', '/api/auth/login', undefined, {
        email: `${randomUUID()}@example.test`,
        password: newOpaqueToken(),
      }),
    ),
  );
  expect(responses.some((response) => response.statusCode === 429)).toBe(true);
});
it('rotates refresh tokens and immediately revokes the whole family upon reuse', async () => {
  const rotated = await f.request(
    'POST',
    '/api/auth/refresh',
    undefined,
    {},
    { [REFRESH_COOKIE]: f.doctor.refresh },
  );
  expect(rotated.statusCode).toBe(200);
  const token = AuthResponseSchema.parse(rotated.json<unknown>()).accessToken;
  const replacement = rotated.cookies.find((cookie) => cookie.name === REFRESH_COOKIE)?.value;
  expect(replacement).not.toBe(f.doctor.refresh);
  const [old] = await f.db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, digest(f.doctor.refresh)));
  expect(old?.usedAt).not.toBeNull();
  expect(
    (
      await f.request(
        'POST',
        '/api/auth/refresh',
        undefined,
        {},
        { [REFRESH_COOKIE]: f.doctor.refresh },
      )
    ).statusCode,
  ).toBe(401);
  expect((await f.request('GET', '/api/auth/me', token)).statusCode).toBe(401);
});
it('detects parallel refresh replay atomically', async () => {
  const responses = await Promise.all(
    [1, 2].map(() =>
      f.request('POST', '/api/auth/refresh', undefined, {}, { [REFRESH_COOKIE]: f.doctor.refresh }),
    ),
  );
  expect(responses.map((row) => row.statusCode).sort()).toEqual([200, 401]);
  const [session] = await f.db.select().from(sessions).where(eq(sessions.userId, f.doctor.user.id));
  expect(session?.revokedAt).not.toBeNull();
});
it('logout invalidates existing access tokens, even before JWT expiry', async () => {
  expect(
    (
      await f.request(
        'POST',
        '/api/auth/logout',
        undefined,
        {},
        { [REFRESH_COOKIE]: f.doctor.refresh },
      )
    ).statusCode,
  ).toBe(200);
  expect((await f.request('GET', '/api/auth/me', f.doctor.accessToken)).statusCode).toBe(401);
});
it('refresh does not extend idle timeout and neither refresh nor access bypass the absolute TTL', async () => {
  f.advance(IDLE_MS + 1);
  expect(
    (
      await f.request(
        'POST',
        '/api/auth/refresh',
        undefined,
        {},
        { [REFRESH_COOKIE]: f.doctor.refresh },
      )
    ).statusCode,
  ).toBe(401);
  f.advance(SESSION_MS);
  expect((await f.request('GET', '/api/auth/me', f.doctor.accessToken)).statusCode).toBe(401);
});
it('doctor revocation disables access, refresh, and remembered patient devices', async () => {
  const patient = await f.enroll();
  expect(
    (
      await f.request(
        'POST',
        `/api/patients/${f.patientId}/sessions/revoke`,
        f.doctor.accessToken,
        {},
      )
    ).statusCode,
  ).toBe(200);
  expect((await f.request('GET', '/api/auth/me', patient.accessToken)).statusCode).toBe(401);
  expect(
    (
      await f.request(
        'POST',
        '/api/auth/refresh',
        undefined,
        {},
        { [REFRESH_COOKIE]: patient.refresh },
      )
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await f.request(
        'POST',
        '/api/auth/patient/login',
        undefined,
        { personalCode: patient.personalCode },
        { [DEVICE_COOKIE]: patient.device },
      )
    ).statusCode,
  ).toBe(401);
});
it('blocks cross-origin mutations, including login, refresh and logout', async () => {
  expect(
    (
      await f.request(
        'POST',
        '/api/auth/login',
        undefined,
        { email: f.doctor.email, password: f.password },
        undefined,
        'https://attacker.test',
      )
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await f.request(
        'POST',
        '/api/auth/refresh',
        undefined,
        {},
        { [REFRESH_COOKIE]: f.doctor.refresh },
        'https://attacker.test',
      )
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await f.request(
        'POST',
        '/api/auth/logout',
        undefined,
        {},
        { [REFRESH_COOKIE]: f.doctor.refresh },
        '',
      )
    ).statusCode,
  ).toBe(403);
  expect((await f.request('GET', '/api/auth/me', f.doctor.accessToken)).statusCode).toBe(200);
});

it('audits only technical identifiers and enforces append-only and no-DDL database privileges', async () => {
  const patient = await f.enroll();
  const rows = await f.db.select().from(auditEvents).orderBy(asc(auditEvents.sequence));
  expect(verifyAuditChain(rows)).toBe(true);
  const encoded = JSON.stringify(rows);
  for (const value of [
    TEST_IDENTITY.firstName,
    TEST_IDENTITY.phone,
    patient.invitation.token,
    patient.personalCode,
    f.password,
    f.doctor.email,
  ])
    expect(encoded).not.toContain(value);
  await expect(f.db.execute(sql`update audit_events set action = 'changed'`)).rejects.toThrow();
  await expect(f.db.execute(sql`delete from audit_events`)).rejects.toThrow();
  await expect(f.db.execute(sql`truncate audit_events`)).rejects.toThrow();
  await expect(f.db.execute(sql`create table forbidden_ddl (id integer)`)).rejects.toThrow();
  await expect(f.db.execute(sql`update consents set version = 'changed'`)).rejects.toThrow();
});
it('serializes concurrent audit appends without breaking the chain', async () => {
  await Promise.all(
    Array.from({ length: 12 }, () =>
      f.db.transaction((tx) => appendAudit(tx, { action: 'auth.failed' })),
    ),
  );
  expect(
    verifyAuditChain(await f.db.select().from(auditEvents).orderBy(asc(auditEvents.sequence))),
  ).toBe(true);
});
it('restricts audit views and chain verification to administrators', async () => {
  const patient = await f.enroll();
  for (const path of ['/api/admin/audit', '/api/admin/audit/verify']) {
    expect((await f.request('GET', path, f.doctor.accessToken)).statusCode).toBe(403);
    expect((await f.request('GET', path, patient.accessToken)).statusCode).toBe(403);
    expect((await f.request('GET', path, f.admin.accessToken)).statusCode).toBe(200);
  }
});
