import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, count, eq } from 'drizzle-orm';
import { Icd10SearchResultSchema, PatientDiagnosesSchema } from '@psychometr/shared';
import { fixture, type Fixture } from '../testing/fixture.js';
import { auditEvents, diagnoses } from '../db/schema.js';

/* FR-7.4: diagnoses in the patient's card — record, remove, ICD-10 catalog, access. */
let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});

const base = (patientId: string) => `/api/patients/${patientId}/diagnoses`;
const diagnosis = (overrides: Record<string, unknown> = {}) => ({
  submissionId: randomUUID(),
  code: 'F41.1',
  text: 'Синтетический диагноз: генерализованное тревожное расстройство',
  ...overrides,
});

async function auditCount(action: string): Promise<number> {
  const [row] = await f.db
    .select({ n: count() })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.resourceId, f.patientId)));
  return row?.n ?? 0;
}
async function list(token = f.doctor.accessToken) {
  const response = await f.request('GET', base(f.patientId), token);
  expect(response.statusCode).toBe(200);
  return PatientDiagnosesSchema.parse(response.json<unknown>()).diagnoses;
}
async function add(body = diagnosis()) {
  const response = await f.request('POST', base(f.patientId), f.doctor.accessToken, body);
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

describe('IDOR matrix for diagnosis routes', () => {
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
    ok: number;
    send: (token: string) => Promise<{ statusCode: number; body: string }>;
  }[] = [
    {
      name: 'GET diagnoses',
      ok: 200,
      send: (token) => f.request('GET', base(f.patientId), token),
    },
    {
      name: 'POST diagnoses',
      ok: 201,
      send: (token) => f.request('POST', base(f.patientId), token, diagnosis()),
    },
    {
      name: 'POST diagnoses/:id/remove',
      ok: 200,
      send: async (token) =>
        f.request('POST', `${base(f.patientId)}/${await add()}/remove`, token, {}),
    },
  ];
  for (const route of cases)
    it.each(roles)(`${route.name}: %s`, async (role) => {
      const token = await tokenFor(role);
      const response = await route.send(token);
      expect(response.statusCode).toBe(role === 'own doctor' ? route.ok : 403);
      if (role !== 'own doctor') {
        expect(response.body).not.toContain('Синтетический диагноз');
        expect(await auditCount('access.denied')).toBeGreaterThan(0);
      }
    });

  it.each(roles)('GET icd10: %s', async (role) => {
    const response = await f.request('GET', '/api/icd10?q=F41', await tokenFor(role));
    const doctor = role === 'own doctor' || role === 'other doctor';
    expect(response.statusCode).toBe(doctor ? 200 : 403);
  });
});

describe('doctor records diagnoses', () => {
  it('stores code and text, lists current first, audits each step', async () => {
    const first = await add();
    const second = await add(diagnosis({ code: null, text: 'Синтетическая формулировка' }));
    const removed = await f.request(
      'POST',
      `${base(f.patientId)}/${first}/remove`,
      f.doctor.accessToken,
      {},
    );
    expect(removed.statusCode).toBe(200);
    const rows = await list();
    expect(rows.map((row) => [row.id, row.code, row.removedAt === null])).toEqual([
      [second, null, true],
      [first, 'F41.1', false],
    ]);
    expect(await auditCount('diagnosis.added')).toBe(2);
    expect(await auditCount('diagnosis.removed')).toBe(1);
    expect(await auditCount('diagnoses.viewed')).toBe(1);
  });

  it('a removed diagnosis cannot be removed again; an unknown one is 404', async () => {
    const id = await add();
    const path = `${base(f.patientId)}/${id}/remove`;
    expect((await f.request('POST', path, f.doctor.accessToken, {})).statusCode).toBe(200);
    expect((await f.request('POST', path, f.doctor.accessToken, {})).statusCode).toBe(409);
    const unknown = `${base(f.patientId)}/${randomUUID()}/remove`;
    expect((await f.request('POST', unknown, f.doctor.accessToken, {})).statusCode).toBe(404);
  });

  it('cannot remove a diagnosis of another patient through own patient URL', async () => {
    const response = await f.request(
      'POST',
      base(f.otherPatientId),
      f.otherDoctor.accessToken,
      diagnosis(),
    );
    const foreign = response.json<{ id: string }>().id;
    const attempt = await f.request(
      'POST',
      `${base(f.patientId)}/${foreign}/remove`,
      f.doctor.accessToken,
      {},
    );
    expect(attempt.statusCode).toBe(404);
    const [row] = await f.db.select().from(diagnoses).where(eq(diagnoses.id, foreign));
    expect(row?.removedAt).toBeNull();
  });

  it('parallel retries of one submission store one diagnosis', async () => {
    const body = diagnosis();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        f.request('POST', base(f.patientId), f.doctor.accessToken, body),
      ),
    );
    expect(responses.every((response) => response.statusCode === 201)).toBe(true);
    expect(new Set(responses.map((response) => response.json<{ id: string }>().id)).size).toBe(1);
    expect(
      await f.db.select().from(diagnoses).where(eq(diagnoses.patientId, f.patientId)),
    ).toHaveLength(1);
  });

  it('rejects a malformed code, empty and overlong text', async () => {
    for (const body of [
      diagnosis({ code: 'F4' }),
      diagnosis({ code: 'f41.1' }),
      diagnosis({ code: 'F99.9' }),
      diagnosis({ text: '   ' }),
      diagnosis({ text: 'а'.repeat(301) }),
      { ...diagnosis(), extra: true },
    ]) {
      const response = await f.request('POST', base(f.patientId), f.doctor.accessToken, body);
      expect(response.statusCode).toBe(400);
    }
    expect(
      await f.db.select().from(diagnoses).where(eq(diagnoses.patientId, f.patientId)),
    ).toHaveLength(0);
  });

  it('the database keeps diagnoses: no edits, no deletes, removal once', async () => {
    const id = await add();
    await expect(
      f.db.update(diagnoses).set({ text: 'изменено' }).where(eq(diagnoses.id, id)),
    ).rejects.toThrow();
    await expect(f.db.delete(diagnoses).where(eq(diagnoses.id, id))).rejects.toThrow();
    await f.db
      .update(diagnoses)
      .set({ removedAt: new Date(), removedBy: f.doctor.user.id })
      .where(eq(diagnoses.id, id));
    await expect(
      f.db
        .update(diagnoses)
        .set({ removedAt: new Date(), removedBy: f.doctor.user.id })
        .where(eq(diagnoses.id, id)),
    ).rejects.toThrow();
  });
});

describe('ICD-10 search', () => {
  async function search(q: string) {
    const response = await f.request(
      'GET',
      `/api/icd10?q=${encodeURIComponent(q)}`,
      f.doctor.accessToken,
    );
    expect(response.statusCode).toBe(200);
    return Icd10SearchResultSchema.parse(response.json<unknown>());
  }

  it('finds by code prefix in any case', async () => {
    const result = await search('f41.');
    expect(result.version).toMatch(/^\d/);
    expect(result.entries.map((entry) => entry.code)).toEqual([
      'F41.0',
      'F41.1',
      'F41.2',
      'F41.3',
      'F41.8',
      'F41.9',
    ]);
  });

  it('finds by words of the name, ё folded, leading match first', async () => {
    const { entries } = await search('генерализ ТРЕВОЖ');
    expect(entries[0]).toEqual({ code: 'F41.1', name: 'Генерализованное тревожное расстройство' });
    const depression = await search('депрессивный эпизод');
    expect(depression.entries[0]?.code).toBe('F32');
    expect(depression.entries.length).toBeLessThanOrEqual(20);
  });

  it('rejects an empty or overlong query', async () => {
    for (const q of ['', '   ', 'а'.repeat(101)]) {
      const response = await f.request(
        'GET',
        `/api/icd10?q=${encodeURIComponent(q)}`,
        f.doctor.accessToken,
      );
      expect(response.statusCode).toBe(400);
    }
    expect((await f.request('GET', '/api/icd10', f.doctor.accessToken)).statusCode).toBe(400);
  });
});
