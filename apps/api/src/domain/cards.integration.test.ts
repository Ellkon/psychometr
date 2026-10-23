import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PatientCardsSchema, type TaskDecisionInput } from '@psychometr/shared';
import { fixture, type Fixture } from '../testing/fixture.js';
import { syntheticRuleEngine, SYNTHETIC_RULE_ID } from '../testing/rules.js';
import { auditEvents, ruleEvaluations, tasks } from '../db/schema.js';
import { verifyAuditChain } from './audit.js';
import { loadScaleCatalog } from './scales.js';

let f: Fixture;
/** The patient can answer only a scale that the doctor has assigned (FR-3 schedule). */
async function assignPhq9(fx: Fixture) {
  const assigned = await fx.request(
    'PUT',
    `/api/patients/${fx.patientId}/scales/phq9/schedule`,
    fx.doctor.accessToken,
    { intervalDays: 14, windowDays: 7, active: true },
  );
  expect(assigned.statusCode).toBe(200);
}

beforeEach(async () => {
  f = await fixture(true, syntheticRuleEngine());
  await assignPhq9(f);
});

const cardsPath = (patientId: string) => `/api/patients/${patientId}/cards`;
const decisionPath = (patientId: string, taskId: string) =>
  `/api/patients/${patientId}/tasks/${taskId}/decision`;

async function phq9(value: number) {
  const loaded = (await loadScaleCatalog()).scales.get('phq9');
  if (!loaded) throw new Error('missing phq9');
  const answers = Object.fromEntries(loaded.file.items.map((item) => [item.id, value]));
  return { submissionId: randomUUID(), answers, functionalAnswer: 0 };
}

async function submitPhq9(patientToken: string, value: number) {
  const response = await f.request(
    'POST',
    `/api/patients/${f.patientId}/scales/phq9/responses`,
    patientToken,
    await phq9(value),
  );
  expect(response.statusCode).toBe(201);
}

async function openTaskId(): Promise<string> {
  const response = await f.request('GET', cardsPath(f.patientId), f.doctor.accessToken);
  const cards = PatientCardsSchema.parse(response.json<unknown>());
  const card = cards.cards.find((item) => item.status === 'requested');
  if (!card) throw new Error('no open card');
  return card.taskId;
}

describe('rule firing on scale submission', () => {
  it('creates one journal row and one open task when the synthetic rule fires', async () => {
    const patient = (await f.enroll()).accessToken;
    await submitPhq9(patient, 2);

    const journal = await f.db
      .select()
      .from(ruleEvaluations)
      .where(eq(ruleEvaluations.patientId, f.patientId));
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      ruleId: SYNTHETIC_RULE_ID,
      ruleVersion: '0.0.1',
      severity: 'warning',
      sourceId: 'pogosova-phq-2014',
    });
    expect(journal[0]?.facts).toMatchObject({
      phq9_total: 18,
      gad7_total: 'unknown',
      pregnancy: 'unknown',
    });

    const response = await f.request('GET', cardsPath(f.patientId), f.doctor.accessToken);
    const cards = PatientCardsSchema.parse(response.json<unknown>());
    expect(cards.routing).toEqual({ status: 'pending_clinical_agreement', activeRules: 0 });
    expect(cards.clarifications.map((item) => item.key)).toEqual([
      'pregnancy',
      'renal_function',
      'hepatic_function',
      'concomitant_medications',
    ]);
    expect(cards.cards).toHaveLength(1);
    expect(cards.cards[0]).toMatchObject({ status: 'requested', comment: null, decidedAt: null });
  });

  it('journals every firing but keeps a single open task per rule', async () => {
    const patient = (await f.enroll()).accessToken;
    await submitPhq9(patient, 2);
    await submitPhq9(patient, 3);

    const journal = await f.db
      .select()
      .from(ruleEvaluations)
      .where(eq(ruleEvaluations.patientId, f.patientId));
    expect(journal).toHaveLength(2);
    const open = await f.db.select().from(tasks).where(eq(tasks.patientId, f.patientId));
    expect(open).toHaveLength(1);
  });

  it('writes no card below the threshold', async () => {
    const patient = (await f.enroll()).accessToken;
    await submitPhq9(patient, 0);
    const journal = await f.db
      .select()
      .from(ruleEvaluations)
      .where(eq(ruleEvaluations.patientId, f.patientId));
    expect(journal).toHaveLength(0);
  });

  it('rolls back the answer if a rule fails, so no answer is stored without its evaluation', async () => {
    f = await fixture(true, syntheticRuleEngine('"yes"'));
    await assignPhq9(f);
    const patient = (await f.enroll()).accessToken;
    const response = await f.request(
      'POST',
      `/api/patients/${f.patientId}/scales/phq9/responses`,
      patient,
      await phq9(2),
    );
    expect(response.statusCode).toBe(500);
    const answers = await f.db.execute(
      sql`select count(*)::int as n from questionnaire_responses where patient_id = ${f.patientId}`,
    );
    expect(Number(answers.rows[0]?.['n'])).toBe(0);
  });
});

describe('doctor decision (FR-4.4)', () => {
  it('rejects a rejection without a comment', async () => {
    await submitPhq9((await f.enroll()).accessToken, 2);
    const taskId = await openTaskId();
    const body: TaskDecisionInput = { decision: 'rejected' };
    const response = await f.request(
      'POST',
      decisionPath(f.patientId, taskId),
      f.doctor.accessToken,
      body,
    );
    expect(response.statusCode).toBe(400);
  });

  it('records acceptance once and answers a repeat decision with 409', async () => {
    await submitPhq9((await f.enroll()).accessToken, 2);
    const taskId = await openTaskId();
    const first = await f.request('POST', decisionPath(f.patientId, taskId), f.doctor.accessToken, {
      decision: 'accepted',
    });
    expect(first.statusCode).toBe(200);
    const again = await f.request('POST', decisionPath(f.patientId, taskId), f.doctor.accessToken, {
      decision: 'rejected',
      comment: 'поздно',
    });
    expect(again.statusCode).toBe(409);

    const cards = PatientCardsSchema.parse(
      (await f.request('GET', cardsPath(f.patientId), f.doctor.accessToken)).json<unknown>(),
    );
    expect(cards.cards[0]).toMatchObject({ status: 'accepted', comment: null });
    expect(cards.cards[0]?.decidedAt).not.toBeNull();
  });

  it('stores a rejection comment', async () => {
    await submitPhq9((await f.enroll()).accessToken, 2);
    const taskId = await openTaskId();
    const response = await f.request(
      'POST',
      decisionPath(f.patientId, taskId),
      f.doctor.accessToken,
      {
        decision: 'rejected',
        comment: 'Пациент уже наблюдается у психиатра.',
      },
    );
    expect(response.statusCode).toBe(200);
    const [row] = await f.db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row).toMatchObject({
      status: 'rejected',
      comment: 'Пациент уже наблюдается у психиатра.',
    });
  });

  it('returns 404 for a task that belongs to another patient', async () => {
    await submitPhq9((await f.enroll()).accessToken, 2);
    const taskId = await openTaskId();
    const response = await f.request(
      'POST',
      decisionPath(f.otherPatientId, taskId),
      f.otherDoctor.accessToken,
      { decision: 'accepted' },
    );
    expect(response.statusCode).toBe(404);
  });
});

describe('IDOR and roles for cards', () => {
  let ownPatient: string;
  beforeEach(async () => {
    ownPatient = (await f.enroll()).accessToken;
    await submitPhq9(ownPatient, 2);
  });

  it.each(['other doctor', 'own patient', 'other patient', 'admin'] as const)(
    'GET cards: %s is refused',
    async (role) => {
      let token: string;
      if (role === 'other doctor') token = f.otherDoctor.accessToken;
      else if (role === 'admin') token = f.admin.accessToken;
      else if (role === 'own patient') token = ownPatient;
      else token = (await f.enroll(f.otherPatientId, f.otherDoctor.accessToken)).accessToken;
      const response = await f.request('GET', cardsPath(f.patientId), token);
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain(SYNTHETIC_RULE_ID);
    },
  );

  it.each(['patient', 'other doctor', 'admin'] as const)(
    'decision: %s cannot decide the task',
    async (role) => {
      const taskId = await openTaskId();
      let token: string;
      if (role === 'patient') token = ownPatient;
      else if (role === 'admin') token = f.admin.accessToken;
      else token = f.otherDoctor.accessToken;
      const response = await f.request('POST', decisionPath(f.patientId, taskId), token, {
        decision: 'accepted',
      });
      expect(response.statusCode).toBe(403);
    },
  );

  it('records a view of cards in the audit trail and keeps the chain valid', async () => {
    await f.request('GET', cardsPath(f.patientId), f.doctor.accessToken);
    const rows = await f.db.select().from(auditEvents).orderBy(auditEvents.sequence);
    expect(
      rows.some((row) => row.action === 'cards.viewed' && row.resourceId === f.patientId),
    ).toBe(true);
    expect(
      rows.some((row) => row.action === 'rule.triggered' && row.detail === SYNTHETIC_RULE_ID),
    ).toBe(true);
    expect(verifyAuditChain(rows)).toBe(true);
  });
});

describe('append-only journal and task transitions', () => {
  beforeEach(async () => {
    await submitPhq9((await f.enroll()).accessToken, 2);
  });

  it('forbids changing or deleting rule evaluations, and truncating them', async () => {
    await expect(
      f.db.execute(sql`update rule_evaluations set message = 'changed'`),
    ).rejects.toThrow();
    await expect(f.db.execute(sql`delete from rule_evaluations`)).rejects.toThrow();
    await expect(f.db.execute(sql`truncate rule_evaluations`)).rejects.toThrow();
  });

  it('forbids deleting or truncating tasks', async () => {
    await expect(f.db.execute(sql`delete from tasks`)).rejects.toThrow();
    await expect(f.db.execute(sql`truncate tasks`)).rejects.toThrow();
  });

  it('allows requested → accepted once; a repeat change or a patient change is refused', async () => {
    const taskId = await openTaskId();
    await expect(
      f.db.execute(sql`update tasks set patient_id = ${f.otherPatientId} where id = ${taskId}`),
    ).rejects.toThrow();
    await expect(
      f.db.execute(
        sql`update tasks set status = 'requested', decided_at = now() where id = ${taskId}`,
      ),
    ).rejects.toThrow();
    await f.db.execute(
      sql`update tasks set status = 'accepted', decided_at = now() where id = ${taskId}`,
    );
    await expect(
      f.db.execute(
        sql`update tasks set status = 'rejected', comment = 'x', decided_at = now() where id = ${taskId}`,
      ),
    ).rejects.toThrow();
  });
});
