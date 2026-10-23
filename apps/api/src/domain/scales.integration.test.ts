import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import {
  AuthResponseSchema,
  PatientScalesSchema,
  ScaleCatalogSchema,
  ScaleResultSchema,
} from '@psychometr/shared';
import { fixture, type Fixture } from '../testing/fixture.js';
import { auditEvents } from '../db/schema.js';
import { verifyAuditChain } from './audit.js';
import { loadScaleCatalog } from './scales.js';

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});

const DAY = 24 * 60 * 60 * 1000;
const schedule = { intervalDays: 14, windowDays: 7, active: true };
const scalePath = (patientId: string, scaleId: string) =>
  `/api/patients/${patientId}/scales/${scaleId}`;

async function itemIds(scaleId: string): Promise<string[]> {
  const loaded = (await loadScaleCatalog()).scales.get(scaleId);
  if (!loaded) throw new Error(`missing ${scaleId}`);
  return loaded.file.items.map((item) => item.id);
}
async function submission(scaleId: string, value = 0, safety?: number) {
  const ids = await itemIds(scaleId);
  const answers: Record<string, number> = Object.fromEntries(ids.map((id) => [id, value]));
  if (safety !== undefined && scaleId === 'phq9') answers['phq9_09'] = safety;
  return { submissionId: randomUUID(), answers, functionalAnswer: scaleId === 'phq9' ? 0 : null };
}
const setSchedule = (token: string, patientId: string, scaleId = 'phq9') =>
  f.request('PUT', `${scalePath(patientId, scaleId)}/schedule`, token, schedule);

describe('scale catalog', () => {
  it('serves published scales to any signed-in user and nothing to anonymous callers', async () => {
    expect((await f.request('GET', '/api/scales')).statusCode).toBe(401);
    for (const token of [f.doctor.accessToken, f.admin.accessToken]) {
      const response = await f.request('GET', '/api/scales', token);
      expect(response.statusCode).toBe(200);
      const catalog = ScaleCatalogSchema.parse(response.json<unknown>());
      expect(catalog.scales.map((scale) => scale.id).sort()).toEqual(['gad7', 'phq9']);
    }
  });
});

describe('IDOR matrix: GET /api/patients/:patientId/scales', () => {
  it.each(['own doctor', 'other doctor', 'own patient', 'other patient', 'admin'] as const)(
    '%s',
    async (role) => {
      let token: string;
      if (role === 'own doctor') token = f.doctor.accessToken;
      else if (role === 'other doctor') token = f.otherDoctor.accessToken;
      else if (role === 'admin') token = f.admin.accessToken;
      else if (role === 'own patient') token = (await f.enroll()).accessToken;
      else token = (await f.enroll(f.otherPatientId, f.otherDoctor.accessToken)).accessToken;
      const allowed = role === 'own doctor' || role === 'own patient';
      const response = await f.request('GET', `/api/patients/${f.patientId}/scales`, token);
      expect(response.statusCode).toBe(allowed ? 200 : 403);
      if (allowed) PatientScalesSchema.parse(response.json<unknown>());
      else {
        const denials = await f.db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, 'access.denied'));
        expect(denials.some((row) => row.resourceId === f.patientId)).toBe(true);
      }
    },
  );
});

describe('IDOR matrix: POST /api/patients/:patientId/scales/:scaleId/responses', () => {
  it.each(['own doctor', 'other doctor', 'own patient', 'other patient', 'admin'] as const)(
    '%s',
    async (role) => {
      expect((await setSchedule(f.doctor.accessToken, f.patientId)).statusCode).toBe(200);
      let token: string;
      if (role === 'own doctor') token = f.doctor.accessToken;
      else if (role === 'other doctor') token = f.otherDoctor.accessToken;
      else if (role === 'admin') token = f.admin.accessToken;
      else if (role === 'own patient') token = (await f.enroll()).accessToken;
      else token = (await f.enroll(f.otherPatientId, f.otherDoctor.accessToken)).accessToken;
      const response = await f.request(
        'POST',
        `${scalePath(f.patientId, 'phq9')}/responses`,
        token,
        await submission('phq9', 0),
      );
      // Clinicians never answer for the patient, even when they manage the patient.
      const allowed = role === 'own patient';
      expect(response.statusCode).toBe(allowed ? 201 : 403);
    },
  );
});

describe('IDOR matrix: PUT /api/patients/:patientId/scales/:scaleId/schedule', () => {
  it.each(['own doctor', 'other doctor', 'own patient', 'other patient', 'admin'] as const)(
    '%s',
    async (role) => {
      let token: string;
      if (role === 'own doctor') token = f.doctor.accessToken;
      else if (role === 'other doctor') token = f.otherDoctor.accessToken;
      else if (role === 'admin') token = f.admin.accessToken;
      else if (role === 'own patient') token = (await f.enroll()).accessToken;
      else token = (await f.enroll(f.otherPatientId, f.otherDoctor.accessToken)).accessToken;
      const response = await setSchedule(token, f.patientId);
      expect(response.statusCode).toBe(role === 'own doctor' ? 200 : 403);
    },
  );
});

describe('scale workflow', () => {
  it('rejects unknown scales and submissions to unassigned scales', async () => {
    expect((await setSchedule(f.doctor.accessToken, f.patientId, 'bdi')).statusCode).toBe(404);
    const patient = (await f.enroll()).accessToken;
    expect(
      (
        await f.request(
          'POST',
          `${scalePath(f.patientId, 'gad7')}/responses`,
          patient,
          await submission('gad7', 1),
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.request(
          'POST',
          `${scalePath(f.patientId, 'bdi')}/responses`,
          patient,
          await submission('gad7', 1),
        )
      ).statusCode,
    ).toBe(404);
  });

  it('rejects incomplete, extra or out-of-range answers', async () => {
    await setSchedule(f.doctor.accessToken, f.patientId, 'gad7');
    const patient = (await f.enroll()).accessToken;
    const valid = await submission('gad7', 1);
    const [firstId = 'gad7_01'] = Object.keys(valid.answers);
    const incomplete = {
      submissionId: valid.submissionId,
      answers: Object.fromEntries(Object.entries(valid.answers).filter(([id]) => id !== firstId)),
      functionalAnswer: null,
    };
    const extra = { ...valid, answers: { ...valid.answers, injected: 1 } };
    const outOfRange = { ...valid, answers: { ...valid.answers, [firstId]: 4 } };
    for (const body of [incomplete, extra, outOfRange]) {
      const response = await f.request(
        'POST',
        `${scalePath(f.patientId, 'gad7')}/responses`,
        patient,
        body,
      );
      expect(response.statusCode).toBe(400);
    }
    const accepted = await f.request(
      'POST',
      `${scalePath(f.patientId, 'gad7')}/responses`,
      patient,
      valid,
    );
    expect(accepted.statusCode).toBe(201);
  });

  it('stores a retried or duplicated submission once and returns the stored result', async () => {
    await setSchedule(f.doctor.accessToken, f.patientId);
    await setSchedule(f.doctor.accessToken, f.patientId, 'gad7');
    const patient = (await f.enroll()).accessToken;
    const body = await submission('phq9', 1);
    const send = (scaleId: string, payload: unknown) =>
      f.request('POST', `${scalePath(f.patientId, scaleId)}/responses`, patient, payload);
    const [first, second] = await Promise.all([send('phq9', body), send('phq9', body)]);
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(first.json<unknown>()).toEqual(second.json<unknown>());
    const retry = await send('phq9', body);
    expect(retry.json<unknown>()).toEqual(first.json<unknown>());
    // The same id for another scale is a client bug, not a retry.
    const gad7 = await submission('gad7', 1);
    expect((await send('gad7', { ...gad7, submissionId: body.submissionId })).statusCode).toBe(409);
    const listing = await f.request('GET', `/api/patients/${f.patientId}/scales`, patient);
    expect(PatientScalesSchema.parse(listing.json<unknown>()).history).toHaveLength(1);
  });

  it('scores on the server, stores the observation, and shows it to the doctor and patient', async () => {
    expect((await setSchedule(f.doctor.accessToken, f.patientId)).statusCode).toBe(200);
    const patient = (await f.enroll()).accessToken;
    // Items 1–8 at 1, item 9 at 2: total 10, band "Умеренная", safety signal on.
    const body = await submission('phq9', 1, 2);
    const answered = await f.request(
      'POST',
      `${scalePath(f.patientId, 'phq9')}/responses`,
      patient,
      body,
    );
    expect(answered.statusCode).toBe(201);
    const result = ScaleResultSchema.parse(answered.json<unknown>());
    expect(result).toMatchObject({
      scaleId: 'phq9',
      score: 10,
      maxScore: 27,
      bandLabel: 'Умеренная',
      safetySignal: true,
    });
    for (const token of [f.doctor.accessToken, patient]) {
      const listing = await f.request('GET', `/api/patients/${f.patientId}/scales`, token);
      const parsed = PatientScalesSchema.parse(listing.json<unknown>());
      expect(parsed.history).toHaveLength(1);
      expect(parsed.history[0]).toMatchObject({ score: 10, bandLabel: 'Умеренная' });
      expect(parsed.schedules[0]).toMatchObject({ scaleId: 'phq9', status: 'scheduled' });
    }
    const audit = await f.db.select().from(auditEvents).orderBy(asc(auditEvents.sequence));
    expect(
      audit.some((row) => row.action === 'scale.answered' && row.resourceId === f.patientId),
    ).toBe(true);
    expect(audit.some((row) => row.action === 'scale.schedule_changed')).toBe(true);
    expect(audit.some((row) => row.action === 'scale.history_viewed')).toBe(true);
    expect(verifyAuditChain(audit)).toBe(true);
  });

  it('shows a patient with item 9 at zero no safety signal', async () => {
    await setSchedule(f.doctor.accessToken, f.patientId);
    const patient = (await f.enroll()).accessToken;
    const answered = await f.request(
      'POST',
      `${scalePath(f.patientId, 'phq9')}/responses`,
      patient,
      await submission('phq9', 1, 0),
    );
    expect(ScaleResultSchema.parse(answered.json<unknown>()).safetySignal).toBe(false);
  });

  it('marks a schedule overdue after the window passes and pauses it when deactivated', async () => {
    await setSchedule(f.doctor.accessToken, f.patientId);
    const patient = (await f.enroll()).accessToken;
    await f.request(
      'POST',
      `${scalePath(f.patientId, 'phq9')}/responses`,
      patient,
      await submission('phq9', 0, 0),
    );
    // Idle sessions expire after 15 minutes, so the doctor signs in again after each jump.
    const doctorLogin = async () => {
      const response = await f.request('POST', '/api/auth/login', undefined, {
        email: f.doctor.email,
        password: f.password,
      });
      return AuthResponseSchema.parse(response.json<unknown>()).accessToken;
    };
    const status = async (token: string) => {
      const listing = await f.request('GET', `/api/patients/${f.patientId}/scales`, token);
      return PatientScalesSchema.parse(listing.json<unknown>()).schedules[0];
    };
    f.advance(14 * DAY - 1000);
    let token = await doctorLogin();
    expect((await status(token))?.status).toBe('scheduled');
    f.advance(2000);
    token = await doctorLogin();
    expect((await status(token))?.status).toBe('due');
    f.advance(8 * DAY);
    token = await doctorLogin();
    expect((await status(token))?.status).toBe('overdue');
    const paused = await f.request('PUT', `${scalePath(f.patientId, 'phq9')}/schedule`, token, {
      ...schedule,
      active: false,
    });
    expect(paused.statusCode).toBe(200);
    expect((await status(token))?.status).toBe('paused');
  });

  it('keeps clinical records append-only at the database level', async () => {
    await setSchedule(f.doctor.accessToken, f.patientId);
    const patient = (await f.enroll()).accessToken;
    await f.request(
      'POST',
      `${scalePath(f.patientId, 'phq9')}/responses`,
      patient,
      await submission('phq9', 0),
    );
    await expect(
      f.db.execute(sql`update questionnaire_responses set scale_version = 'x'`),
    ).rejects.toThrow();
    await expect(f.db.execute(sql`delete from questionnaire_responses`)).rejects.toThrow();
    await expect(f.db.execute(sql`update observations set score = 0`)).rejects.toThrow();
    await expect(f.db.execute(sql`delete from observations`)).rejects.toThrow();
    await expect(f.db.execute(sql`truncate observations`)).rejects.toThrow();
    await expect(f.db.execute(sql`select 1 from observations where false`)).resolves.toBeDefined();
  });
});

describe('scale audit trail', () => {
  it('records schedule changes, answers and history reads in a verifiable chain', async () => {
    expect((await setSchedule(f.doctor.accessToken, f.patientId)).statusCode).toBe(200);
    const patient = (await f.enroll()).accessToken;
    const answered = await f.request(
      'POST',
      `${scalePath(f.patientId, 'phq9')}/responses`,
      patient,
      await submission('phq9', 1),
    );
    expect(answered.statusCode).toBe(201);
    expect(
      (await f.request('GET', `/api/patients/${f.patientId}/scales`, f.doctor.accessToken))
        .statusCode,
    ).toBe(200);
    const rows = await f.db.select().from(auditEvents).orderBy(asc(auditEvents.sequence));
    const actions = rows.map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining(['scale.schedule_changed', 'scale.answered', 'scale.history_viewed']),
    );
    expect(verifyAuditChain(rows)).toBe(true);
    // Scale actions name the scale; history reads cover all scales and carry no detail.
    expect(rows.find((row) => row.action === 'scale.answered')?.detail).toBe('phq9');
    expect(rows.find((row) => row.action === 'scale.schedule_changed')?.detail).toBe('phq9');
    expect(rows.find((row) => row.action === 'scale.history_viewed')?.detail).toBeNull();
    // A changed scale identifier breaks the chain, so the detail is covered by the hash.
    const tampered = rows.map((row) =>
      row.action === 'scale.answered' ? { ...row, detail: 'gad7' } : row,
    );
    expect(verifyAuditChain(tampered)).toBe(false);
  });
});

describe('database privileges of the app role', () => {
  it('keeps answers and scores append-only and limits schedule updates to their settings', async () => {
    await setSchedule(f.doctor.accessToken, f.patientId);
    const patient = (await f.enroll()).accessToken;
    await f.request('POST', `${scalePath(f.patientId, 'phq9')}/responses`, patient, {
      ...(await submission('phq9', 1)),
    });
    for (const table of ['questionnaire_responses', 'observations']) {
      await expect(
        f.db.execute(sql`update ${sql.identifier(table)} set scale_id = 'gad7'`),
      ).rejects.toThrow();
      await expect(f.db.execute(sql`delete from ${sql.identifier(table)}`)).rejects.toThrow();
    }
    await expect(
      f.db.execute(sql`update scale_schedules set patient_id = ${f.otherPatientId}`),
    ).rejects.toThrow();
    await expect(
      f.db.execute(sql`update scale_schedules set starts_at = now() - interval '1 year'`),
    ).rejects.toThrow();
    await expect(f.db.execute(sql`delete from scale_schedules`)).rejects.toThrow();
  });
});
