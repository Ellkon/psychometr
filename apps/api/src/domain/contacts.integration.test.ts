import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, count, eq } from 'drizzle-orm';
import {
  AlertListSchema,
  PatientContactsSchema,
  RegistrySchema,
  TimelineSchema,
  addWorkingDays,
  type Alert,
} from '@psychometr/shared';
import { fixture, type Fixture } from '../testing/fixture.js';
import { alerts, auditEvents, careTeam, contactRequests, contacts } from '../db/schema.js';
import { IdentityVault } from '../security/identity.js';
import { AlertHub, AlertService } from './alerts.js';

/* FR-12: contact between visits — patient requests, doctor contacts, escalation, access. */
let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});

const base = (patientId: string) => `/api/patients/${patientId}`;
const ask = (overrides: Record<string, unknown> = {}) => ({
  submissionId: randomUUID(),
  reason: 'side_effect',
  preferredTime: 'evening',
  ...overrides,
});
const contact = (overrides: Record<string, unknown> = {}) => ({
  submissionId: randomUUID(),
  channel: 'phone',
  contactedAt: new Date().toISOString(),
  note: 'Синтетическая заметка: обсудили побочное действие',
  ...overrides,
});

function service() {
  return new AlertService(
    f.db,
    new IdentityVault(Buffer.from(f.env.APP_ENCRYPTION_KEY, 'base64')),
    new AlertHub(),
  );
}
async function listAlerts(token: string): Promise<Alert[]> {
  const response = await f.request('GET', '/api/alerts', token);
  expect(response.statusCode).toBe(200);
  return AlertListSchema.parse(response.json<unknown>()).alerts;
}
async function auditCount(action: string): Promise<number> {
  const [row] = await f.db
    .select({ n: count() })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.resourceId, f.patientId)));
  return row?.n ?? 0;
}
async function registryRow(token = f.doctor.accessToken) {
  const response = await f.request('GET', '/api/registry', token);
  expect(response.statusCode).toBe(200);
  return RegistrySchema.parse(response.json<unknown>()).patients.find(
    (row) => row.patientId === f.patientId,
  );
}

describe('working days (FR-12 response time)', () => {
  it('skips Saturday and Sunday in Moscow time', () => {
    // Friday 15:00 MSK → Wednesday 15:00 MSK.
    expect(addWorkingDays(new Date('2026-10-23T12:00:00Z'), 3).toISOString()).toBe(
      '2026-10-28T12:00:00.000Z',
    );
    // Saturday 10:00 MSK → Wednesday 10:00 MSK.
    expect(addWorkingDays(new Date('2026-10-24T07:00:00Z'), 3).toISOString()).toBe(
      '2026-10-28T07:00:00.000Z',
    );
    // Friday 23:30 MSK is already Saturday 00:30 a day later: the weekday is taken in MSK.
    expect(addWorkingDays(new Date('2026-10-23T20:30:00Z'), 1).toISOString()).toBe(
      '2026-10-26T20:30:00.000Z',
    );
  });
});

describe('IDOR matrix for contact routes', () => {
  type Role = 'own doctor' | 'other doctor' | 'own patient' | 'other patient' | 'admin';
  const roles: Role[] = ['own doctor', 'other doctor', 'own patient', 'other patient', 'admin'];
  async function tokenFor(role: Role): Promise<string> {
    if (role === 'own doctor') return f.doctor.accessToken;
    if (role === 'other doctor') return f.otherDoctor.accessToken;
    if (role === 'admin') return f.admin.accessToken;
    if (role === 'own patient') return (await f.enroll()).accessToken;
    return (await f.enroll(f.otherPatientId, f.otherDoctor.accessToken)).accessToken;
  }
  const cases: {
    name: string;
    allowed: Role[];
    ok: number;
    send: (token: string) => Promise<{ statusCode: number; body: string }>;
  }[] = [
    {
      name: 'GET contacts',
      allowed: ['own doctor', 'own patient'],
      ok: 200,
      send: (token) => f.request('GET', `${base(f.patientId)}/contacts`, token),
    },
    {
      name: 'POST contact-requests',
      allowed: ['own patient'],
      ok: 201,
      send: (token) => f.request('POST', `${base(f.patientId)}/contact-requests`, token, ask()),
    },
    {
      name: 'POST contacts',
      allowed: ['own doctor'],
      ok: 201,
      send: (token) => f.request('POST', `${base(f.patientId)}/contacts`, token, contact()),
    },
  ];
  for (const route of cases)
    it.each(roles)(`${route.name}: %s`, async (role) => {
      const response = await route.send(await tokenFor(role));
      expect(response.statusCode).toBe(route.allowed.includes(role) ? route.ok : 403);
      if (!route.allowed.includes(role)) {
        expect(response.body).not.toContain('Синтетическая заметка');
        expect(await auditCount('access.denied')).toBeGreaterThan(0);
      }
    });
});

describe('patient asks to be contacted', () => {
  let patient: string;
  beforeEach(async () => {
    patient = (await f.enroll()).accessToken;
  });

  it('notifies the primary doctor with reason and time, due in 3 working days', async () => {
    const response = await f.request(
      'POST',
      `${base(f.patientId)}/contact-requests`,
      patient,
      ask(),
    );
    expect(response.statusCode).toBe(201);
    const [alert, ...rest] = await listAlerts(f.doctor.accessToken);
    expect(rest).toHaveLength(0);
    expect(alert).toMatchObject({
      source: 'contact_request',
      severity: 'warning',
      ruleId: null,
      message: 'Пациент просит связаться. Побочное действие. Удобное время: вечером.',
    });
    const [row] = await f.db.select().from(alerts).where(eq(alerts.patientId, f.patientId));
    const [request] = await f.db
      .select()
      .from(contactRequests)
      .where(eq(contactRequests.patientId, f.patientId));
    if (!row?.escalateAt || !request) throw new Error('missing rows');
    expect(row.escalateAt.toISOString()).toBe(addWorkingDays(request.createdAt, 3).toISOString());
    expect((await registryRow())?.openContactRequests).toBe(1);
    expect(await auditCount('contact_request.created')).toBe(1);
  });

  it('a second press while one is open returns the open request instead of a new one', async () => {
    const first = await f.request('POST', `${base(f.patientId)}/contact-requests`, patient, ask());
    const again = await f.request(
      'POST',
      `${base(f.patientId)}/contact-requests`,
      patient,
      ask({ reason: 'worse' }),
    );
    expect(again.statusCode).toBe(200);
    expect(again.json<{ id: string; existing: boolean }>()).toEqual({
      id: first.json<{ id: string }>().id,
      existing: true,
    });
    expect(
      await f.db.select().from(contactRequests).where(eq(contactRequests.patientId, f.patientId)),
    ).toHaveLength(1);
    expect(await listAlerts(f.doctor.accessToken)).toHaveLength(1);
  });

  it('ten parallel presses store one request and one notification', async () => {
    const body = ask();
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        f.request(
          'POST',
          `${base(f.patientId)}/contact-requests`,
          patient,
          i % 2 ? body : ask({ reason: 'other' }),
        ),
      ),
    );
    expect(responses.every((response) => response.statusCode < 300)).toBe(true);
    expect(
      await f.db.select().from(contactRequests).where(eq(contactRequests.patientId, f.patientId)),
    ).toHaveLength(1);
    expect(await f.db.select().from(alerts).where(eq(alerts.patientId, f.patientId))).toHaveLength(
      1,
    );
    expect(await auditCount('alert.created')).toBe(1);
  });

  it('rejects values outside the lists and free text', async () => {
    const send = (body: unknown) =>
      f.request('POST', `${base(f.patientId)}/contact-requests`, patient, body);
    expect((await send(ask({ reason: 'emergency' }))).statusCode).toBe(400);
    expect((await send(ask({ comment: 'текст' }))).statusCode).toBe(400);
  });
});

describe('doctor records a contact', () => {
  let patient: string;
  beforeEach(async () => {
    patient = (await f.enroll()).accessToken;
    await f.request('POST', `${base(f.patientId)}/contact-requests`, patient, ask());
  });

  it('resolves the request, closes its notification and counts as contact', async () => {
    const response = await f.request(
      'POST',
      `${base(f.patientId)}/contacts`,
      f.doctor.accessToken,
      contact(),
    );
    expect(response.statusCode).toBe(201);
    expect(await listAlerts(f.doctor.accessToken)).toHaveLength(0);
    const row = await registryRow();
    expect(row).toMatchObject({ openContactRequests: 0, weeksWithoutContact: 0 });

    const forDoctor = PatientContactsSchema.parse(
      (
        await f.request('GET', `${base(f.patientId)}/contacts`, f.doctor.accessToken)
      ).json<unknown>(),
    );
    expect(forDoctor.requests[0]?.resolvedAt).not.toBeNull();
    expect(forDoctor.contacts[0]?.note).toContain('Синтетическая заметка');

    // The patient sees that the doctor got in touch, not the doctor's note.
    const forPatient = await f.request('GET', `${base(f.patientId)}/contacts`, patient);
    expect(forPatient.body).not.toContain('Синтетическая заметка');
    expect(PatientContactsSchema.parse(forPatient.json<unknown>()).contacts[0]).toMatchObject({
      channel: 'phone',
      note: null,
    });

    const timeline = TimelineSchema.parse(
      (
        await f.request('GET', `${base(f.patientId)}/timeline`, f.doctor.accessToken)
      ).json<unknown>(),
    );
    const kinds = timeline.events.map((event) => event.kind);
    expect(kinds).toContain('contact');
    expect(kinds).toContain('contact_request');
    expect(await auditCount('contact.recorded')).toBe(1);
  });

  it('a retried contact is stored once; a new request can follow', async () => {
    const body = contact();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        f.request('POST', `${base(f.patientId)}/contacts`, f.doctor.accessToken, body),
      ),
    );
    expect(responses.every((response) => response.statusCode === 201)).toBe(true);
    expect(
      await f.db.select().from(contacts).where(eq(contacts.patientId, f.patientId)),
    ).toHaveLength(1);
    const next = await f.request('POST', `${base(f.patientId)}/contact-requests`, patient, ask());
    expect(next.statusCode).toBe(201);
    expect(
      await f.db.select().from(contactRequests).where(eq(contactRequests.patientId, f.patientId)),
    ).toHaveLength(2);
  });

  it('refuses a contact in the future or older than 30 days', async () => {
    const send = (contactedAt: Date) =>
      f.request(
        'POST',
        `${base(f.patientId)}/contacts`,
        f.doctor.accessToken,
        contact({ contactedAt: contactedAt.toISOString() }),
      );
    expect((await send(new Date(Date.now() + 60 * 60_000))).statusCode).toBe(400);
    expect((await send(new Date(Date.now() - 31 * 24 * 60 * 60_000))).statusCode).toBe(400);
    expect((await registryRow())?.openContactRequests).toBe(1);
  });
});

describe('escalation of an unanswered request (owner decision 2026-10-25)', () => {
  it('goes to the reserve doctor after 3 working days, and a contact closes both', async () => {
    await f.db.insert(careTeam).values({
      patientId: f.patientId,
      practitionerId: f.otherDoctor.user.id,
    });
    const patient = (await f.enroll()).accessToken;
    await f.request('POST', `${base(f.patientId)}/contact-requests`, patient, ask());
    const [row] = await f.db.select().from(alerts).where(eq(alerts.patientId, f.patientId));
    if (!row?.escalateAt) throw new Error('no timer');

    await service().escalate(new Date(row.escalateAt.getTime() - 60_000));
    expect(await listAlerts(f.otherDoctor.accessToken)).toHaveLength(0);
    await service().escalate(new Date(row.escalateAt.getTime() + 60_000));
    const [copy] = await listAlerts(f.otherDoctor.accessToken);
    expect(copy).toMatchObject({ source: 'contact_request', escalatedFrom: row.id });

    // The reserve doctor gets in touch: the request and both notifications are closed.
    const done = await f.request(
      'POST',
      `${base(f.patientId)}/contacts`,
      f.otherDoctor.accessToken,
      contact(),
    );
    expect(done.statusCode).toBe(201);
    expect(await listAlerts(f.doctor.accessToken)).toHaveLength(0);
    expect(await listAlerts(f.otherDoctor.accessToken)).toHaveLength(0);
  });
});

describe('database guards', () => {
  it('contacts are append-only and a request is resolved only once', async () => {
    const patient = (await f.enroll()).accessToken;
    await f.request('POST', `${base(f.patientId)}/contact-requests`, patient, ask());
    await f.request('POST', `${base(f.patientId)}/contacts`, f.doctor.accessToken, contact());
    const [stored] = await f.db.select().from(contacts).where(eq(contacts.patientId, f.patientId));
    const [request] = await f.db
      .select()
      .from(contactRequests)
      .where(eq(contactRequests.patientId, f.patientId));
    if (!stored || !request) throw new Error('missing rows');
    await expect(
      f.db.update(contacts).set({ note: 'changed' }).where(eq(contacts.id, stored.id)),
    ).rejects.toThrow();
    await expect(f.db.delete(contacts).where(eq(contacts.id, stored.id))).rejects.toThrow();
    await expect(
      f.db
        .update(contactRequests)
        .set({ resolvedAt: new Date() })
        .where(eq(contactRequests.id, request.id)),
    ).rejects.toThrow();
    await expect(
      f.db.delete(contactRequests).where(eq(contactRequests.id, request.id)),
    ).rejects.toThrow();
  });
});
