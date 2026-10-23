import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import {
  AuthResponseSchema,
  DrugCatalogSchema,
  PatientTherapySchema,
  RegistrySchema,
  TimelineSchema,
} from '@psychometr/shared';
import { fixture, type Fixture } from '../testing/fixture.js';
import { auditEvents } from '../db/schema.js';
import { DEVICE_COOKIE } from '../routes/access.js';
import { verifyAuditChain } from './audit.js';

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});

const HOUR = 60 * 60 * 1000;
const base = (patientId: string) => `/api/patients/${patientId}`;
/** UTC "HH:MM" `minutes` from the fixture clock's start; slots then fall right after creation. */
function timeIn(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString().slice(11, 16);
}
function prescription(times = [timeIn(30)]) {
  return {
    grlsRegNumber: null,
    drugText: 'Синтетический препарат',
    doseText: '50 мг',
    doseTimes: times,
    timeZone: 'UTC',
    startsOn: new Date(Date.now() - 24 * HOUR).toISOString().slice(0, 10),
    endsOn: null,
  };
}
const adverse = (overrides: Record<string, unknown> = {}) => ({
  submissionId: randomUUID(),
  description: 'Синтетическое описание: тошнота по утрам',
  severity: 'mild',
  startedOn: new Date().toISOString().slice(0, 10),
  medicationRequestId: null,
  ...overrides,
});
async function prescribe(times?: string[]) {
  const response = await f.request(
    'POST',
    `${base(f.patientId)}/medications`,
    f.doctor.accessToken,
    prescription(times),
  );
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}
async function therapy(token: string) {
  const response = await f.request('GET', `${base(f.patientId)}/therapy`, token);
  expect(response.statusCode).toBe(200);
  return PatientTherapySchema.parse(response.json<unknown>());
}

/** Advancing the clock past the 15-minute idle timeout ends sessions; sign in again. */
async function doctorLogin(): Promise<string> {
  const response = await f.request('POST', '/api/auth/login', undefined, {
    email: f.doctor.email,
    password: f.doctor.password,
  });
  return AuthResponseSchema.parse(response.json<unknown>()).accessToken;
}
async function patientLogin(patient: { device: string; personalCode: string }): Promise<string> {
  const response = await f.request(
    'POST',
    '/api/auth/patient/login',
    undefined,
    { personalCode: patient.personalCode },
    { [DEVICE_COOKIE]: patient.device },
  );
  return AuthResponseSchema.parse(response.json<unknown>()).accessToken;
}

type Role = 'own doctor' | 'other doctor' | 'own patient' | 'other patient' | 'admin';
const roles: Role[] = ['own doctor', 'other doctor', 'own patient', 'other patient', 'admin'];
async function tokenFor(role: Role): Promise<string> {
  if (role === 'own doctor') return f.doctor.accessToken;
  if (role === 'other doctor') return f.otherDoctor.accessToken;
  if (role === 'admin') return f.admin.accessToken;
  if (role === 'own patient') return (await f.enroll()).accessToken;
  return (await f.enroll(f.otherPatientId, f.otherDoctor.accessToken)).accessToken;
}

describe('IDOR matrix for therapy routes', () => {
  const cases: {
    name: string;
    allowed: Role[];
    ok: number;
    send: (token: string) => Promise<{ statusCode: number }>;
  }[] = [
    {
      name: 'GET therapy',
      allowed: ['own doctor', 'own patient'],
      ok: 200,
      send: (token) => f.request('GET', `${base(f.patientId)}/therapy`, token),
    },
    {
      name: 'GET timeline',
      allowed: ['own doctor'],
      ok: 200,
      send: (token) => f.request('GET', `${base(f.patientId)}/timeline`, token),
    },
    {
      name: 'POST medications',
      allowed: ['own doctor'],
      ok: 201,
      send: (token) => f.request('POST', `${base(f.patientId)}/medications`, token, prescription()),
    },
    {
      name: 'POST stop',
      allowed: ['own doctor'],
      ok: 200,
      send: async (token) =>
        f.request('POST', `${base(f.patientId)}/medications/${await prescribe()}/stop`, token, {}),
    },
    {
      name: 'POST doses',
      allowed: ['own patient'],
      ok: 200,
      send: async (token) => {
        const id = await prescribe();
        const slot = (await therapy(f.doctor.accessToken)).medications[0]?.slots[0];
        return f.request('POST', `${base(f.patientId)}/medications/${id}/doses`, token, {
          scheduledFor: slot?.scheduledFor,
          status: 'taken',
        });
      },
    },
    {
      name: 'POST adverse-events',
      allowed: ['own patient'],
      ok: 201,
      send: (token) => f.request('POST', `${base(f.patientId)}/adverse-events`, token, adverse()),
    },
  ];
  for (const route of cases)
    it.each(roles)(`${route.name}: %s`, async (role) => {
      const token = await tokenFor(role);
      const response = await route.send(token);
      expect(response.statusCode).toBe(route.allowed.includes(role) ? route.ok : 403);
      if (!route.allowed.includes(role)) {
        const denials = await f.db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, 'access.denied'));
        expect(denials.some((row) => row.resourceId === f.patientId)).toBe(true);
      }
    });

  it('drug catalog and registry are for doctors only', async () => {
    const catalog = await f.request('GET', '/api/drugs', f.doctor.accessToken);
    expect(catalog.statusCode).toBe(200);
    expect(DrugCatalogSchema.parse(catalog.json<unknown>()).products.length).toBeGreaterThan(0);
    for (const token of [f.admin.accessToken, (await f.enroll()).accessToken]) {
      expect((await f.request('GET', '/api/drugs', token)).statusCode).toBe(403);
      expect((await f.request('GET', '/api/registry', token)).statusCode).toBe(403);
    }
  });

  it('cannot mark a dose of another patient’s prescription through an own patient id', async () => {
    const foreign = await f.request(
      'POST',
      `${base(f.otherPatientId)}/medications`,
      f.otherDoctor.accessToken,
      prescription(),
    );
    const foreignId = foreign.json<{ id: string }>().id;
    const patient = (await f.enroll()).accessToken;
    const response = await f.request(
      'POST',
      `${base(f.patientId)}/medications/${foreignId}/doses`,
      patient,
      { scheduledFor: new Date().toISOString(), status: 'taken' },
    );
    expect(response.statusCode).toBe(404);
    const stop = await f.request(
      'POST',
      `${base(f.patientId)}/medications/${foreignId}/stop`,
      f.doctor.accessToken,
      {},
    );
    expect(stop.statusCode).toBe(404);
  });
});

describe('therapy diary', () => {
  it('validates prescriptions: ГРЛС number must exist, times are unique, zone is real', async () => {
    const send = (body: unknown) =>
      f.request('POST', `${base(f.patientId)}/medications`, f.doctor.accessToken, body);
    expect((await send({ ...prescription(), grlsRegNumber: 'НЕТ-ТАКОГО' })).statusCode).toBe(400);
    expect((await send({ ...prescription(['08:00', '08:00']) })).statusCode).toBe(400);
    expect((await send({ ...prescription(), timeZone: 'Mars/Olympus' })).statusCode).toBe(400);
    expect((await send({ ...prescription(), doseTimes: ['25:00'] })).statusCode).toBe(400);
    const catalog = DrugCatalogSchema.parse(
      (await f.request('GET', '/api/drugs', f.doctor.accessToken)).json<unknown>(),
    );
    const product = catalog.products[0];
    expect(
      (
        await send({
          ...prescription(),
          grlsRegNumber: product?.regNumber,
          drugText: `${product?.inn ?? ''} (${product?.tradeName ?? ''})`,
        })
      ).statusCode,
    ).toBe(201);
  });

  it('marks a dose once, counts adherence and the run of missed doses', async () => {
    const id = await prescribe([timeIn(30), timeIn(40)]);
    const enrolled = await f.enroll();
    let patient = enrolled.accessToken;
    const [first, second] = (await therapy(patient)).medications[0]?.slots ?? [];
    expect(first?.status).toBeNull();
    const mark = (scheduledFor: string | undefined, status: string) =>
      f.request('POST', `${base(f.patientId)}/medications/${id}/doses`, patient, {
        scheduledFor,
        status,
      });
    expect((await mark(first?.scheduledFor, 'taken')).statusCode).toBe(200);
    expect((await mark(first?.scheduledFor, 'taken')).statusCode).toBe(200);
    expect((await mark(first?.scheduledFor, 'skipped')).statusCode).toBe(409);
    // Not a slot of this prescription.
    expect((await mark(new Date().toISOString(), 'taken')).statusCode).toBe(400);
    f.advance(4 * HOUR);
    const doctor = await doctorLogin();
    patient = await patientLogin(enrolled);
    const [medication] = (await therapy(doctor)).medications;
    expect(medication?.adherence).toMatchObject({ expected: 2, taken: 1, skipped: 0 });
    expect(medication?.missedInRow).toBe(1);
    expect(
      medication?.slots.find((slot) => slot.scheduledFor === first?.scheduledFor)?.status,
    ).toBe('taken');
    // Too late to mark the second dose? Not yet: 48 hours are allowed.
    expect((await mark(second?.scheduledFor, 'skipped')).statusCode).toBe(200);
    f.advance(49 * HOUR);
    const later = (await therapy(await doctorLogin())).medications[0];
    expect(later?.slots.some((slot) => slot.scheduledFor === first?.scheduledFor)).toBe(false);
  });

  it('stops a prescription once and refuses marks after the stop', async () => {
    const id = await prescribe();
    const stop = () =>
      f.request('POST', `${base(f.patientId)}/medications/${id}/stop`, f.doctor.accessToken, {});
    expect((await stop()).statusCode).toBe(200);
    expect((await stop()).statusCode).toBe(409);
    const patient = (await f.enroll()).accessToken;
    const [medication] = (await therapy(patient)).medications;
    expect(medication?.status).toBe('stopped');
    expect(medication?.slots).toEqual([]);
  });

  it('stores an adverse event once per submission and checks the linked prescription', async () => {
    const patient = (await f.enroll()).accessToken;
    const body = adverse({ severity: 'moderate' });
    const send = (payload: unknown) =>
      f.request('POST', `${base(f.patientId)}/adverse-events`, patient, payload);
    const [first, second] = await Promise.all([send(body), send(body)]);
    expect(first.statusCode).toBe(201);
    expect(second.json<unknown>()).toEqual(first.json<unknown>());
    expect((await send(adverse({ medicationRequestId: randomUUID() }))).statusCode).toBe(404);
    expect((await send(adverse({ startedOn: '2999-01-01' }))).statusCode).toBe(400);
    expect((await send(adverse({ description: '' }))).statusCode).toBe(400);
    const events = (await therapy(f.doctor.accessToken)).adverseEvents;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ severity: 'moderate' });
  });
});

describe('registry and timeline', () => {
  it('shows facts per patient and marks the patient reviewed after the doctor opens them', async () => {
    await prescribe([timeIn(30), timeIn(40)]);
    const enrolled = await f.enroll();
    f.advance(4 * HOUR);
    const patient = await patientLogin(enrolled);
    await f.request('POST', `${base(f.patientId)}/adverse-events`, patient, adverse());
    const doctor = await doctorLogin();
    const registry = async () => {
      const response = await f.request('GET', '/api/registry', doctor);
      expect(response.statusCode).toBe(200);
      const rows = RegistrySchema.parse(response.json<unknown>()).patients;
      const row = rows.find((candidate) => candidate.patientId === f.patientId);
      expect(rows.some((candidate) => candidate.patientId === f.otherPatientId)).toBe(false);
      return row;
    };
    const before = await registry();
    expect(before).toMatchObject({
      activeMedications: 1,
      missedDosesInRow: 2,
      adverseEventsSinceReview: 1,
      reviewed: false,
      weeksWithoutContact: 0,
    });
    const timeline = await f.request('GET', `${base(f.patientId)}/timeline`, doctor);
    const events = TimelineSchema.parse(timeline.json<unknown>()).events;
    expect(events.map((event) => event.kind)).toEqual(['adverse_event', 'medication_started']);
    expect(await registry()).toMatchObject({ reviewed: true, adverseEventsSinceReview: 0 });
    const audit = await f.db.select().from(auditEvents).orderBy(asc(auditEvents.sequence));
    expect(verifyAuditChain(audit)).toBe(true);
  });
});

describe('database privileges of the app role', () => {
  it('keeps dose marks and adverse events append-only and prescriptions undeletable', async () => {
    const id = await prescribe();
    const patient = (await f.enroll()).accessToken;
    await f.request('POST', `${base(f.patientId)}/adverse-events`, patient, adverse());
    const [slot] = (await therapy(patient)).medications[0]?.slots ?? [];
    await f.request('POST', `${base(f.patientId)}/medications/${id}/doses`, patient, {
      scheduledFor: slot?.scheduledFor,
      status: 'taken',
    });
    for (const table of ['dose_log', 'adverse_events']) {
      await expect(
        f.db.execute(sql`update ${sql.identifier(table)} set patient_id = ${f.otherPatientId}`),
      ).rejects.toThrow();
      await expect(f.db.execute(sql`delete from ${sql.identifier(table)}`)).rejects.toThrow();
    }
    await expect(f.db.execute(sql`delete from medication_requests`)).rejects.toThrow();
    await expect(
      f.db.execute(sql`update medication_requests set drug_text = 'другое'`),
    ).rejects.toThrow();
    await f.db.execute(
      sql`update medication_requests set status = 'stopped', stopped_at = now() where id = ${id}`,
    );
    await expect(
      f.db.execute(
        sql`update medication_requests set status = 'active', stopped_at = null where id = ${id}`,
      ),
    ).rejects.toThrow();
  });
});
