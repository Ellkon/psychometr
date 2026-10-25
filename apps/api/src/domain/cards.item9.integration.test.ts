import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PatientCardsSchema } from '@psychometr/shared';
import { fixture, type Fixture } from '../testing/fixture.js';
import { ruleEvaluations } from '../db/schema.js';
import { loadScaleCatalog } from './scales.js';

/* Real content rules (no synthetic engine): the item-9 critical card must come from content/rules/safety.json. */
let f: Fixture;
let patient: string;
beforeEach(async () => {
  f = await fixture();
  const assigned = await f.request(
    'PUT',
    `/api/patients/${f.patientId}/scales/phq9/schedule`,
    f.doctor.accessToken,
    { intervalDays: 14, windowDays: 7, active: true },
  );
  expect(assigned.statusCode).toBe(200);
  patient = (await f.enroll()).accessToken;
});

async function phq9WithItem9(item9: number) {
  const loaded = (await loadScaleCatalog()).scales.get('phq9');
  if (!loaded) throw new Error('missing phq9');
  const answers = Object.fromEntries(
    loaded.file.items.map((item) => [item.id, item.id === 'phq9_09' ? item9 : 0]),
  );
  return { submissionId: randomUUID(), answers, functionalAnswer: 0 };
}

async function submit(item9: number) {
  return f.request(
    'POST',
    `/api/patients/${f.patientId}/scales/phq9/responses`,
    patient,
    await phq9WithItem9(item9),
  );
}

describe('PHQ-9 item 9 critical card (FR-5.3)', () => {
  it('creates a critical doctor card when item 9 is above 0', async () => {
    expect((await submit(1)).statusCode).toBe(201);

    const journal = await f.db
      .select()
      .from(ruleEvaluations)
      .where(eq(ruleEvaluations.patientId, f.patientId));
    expect(journal.filter((row) => row.ruleId === 'phq9_item9_positive')).toHaveLength(1);

    const cards = PatientCardsSchema.parse(
      (
        await f.request('GET', `/api/patients/${f.patientId}/cards`, f.doctor.accessToken)
      ).json<unknown>(),
    );
    const card = cards.cards.find((item) => item.ruleId === 'phq9_item9_positive');
    expect(card).toMatchObject({
      severity: 'critical',
      status: 'requested',
      sourceId: 'pogosova-phq-2014',
    });
    expect(card?.facts).toMatchObject({ phq9_item9_positive: true });
    expect(card?.message).toContain('Это не заключение о непосредственной угрозе');
    expect(cards.routing.status).toBe('pending_clinical_agreement');
  });

  it('does not create the item-9 card when item 9 is 0', async () => {
    expect((await submit(0)).statusCode).toBe(201);
    const journal = await f.db
      .select()
      .from(ruleEvaluations)
      .where(eq(ruleEvaluations.patientId, f.patientId));
    expect(journal.some((row) => row.ruleId === 'phq9_item9_positive')).toBe(false);
  });

  it('keeps the patient out of the cards view', async () => {
    const response = await f.request('GET', `/api/patients/${f.patientId}/cards`, patient);
    expect(response.statusCode).toBe(403);
  });
});
