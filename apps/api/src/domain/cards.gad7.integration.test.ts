import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PatientCardsSchema } from '@psychometr/shared';
import { fixture, type Fixture } from '../testing/fixture.js';
import { loadScaleCatalog } from './scales.js';

/* Real content rules: GAD-7 band cards must come from content/rules/safety.json (КР457, Приложение Г2). */
let f: Fixture;
let patient: string;
beforeEach(async () => {
  f = await fixture();
  const assigned = await f.request(
    'PUT',
    `/api/patients/${f.patientId}/scales/gad7/schedule`,
    f.doctor.accessToken,
    { intervalDays: 14, windowDays: 7, active: true },
  );
  expect(assigned.statusCode).toBe(200);
  patient = (await f.enroll()).accessToken;
});

async function submitAll(value: number) {
  const loaded = (await loadScaleCatalog()).scales.get('gad7');
  if (!loaded) throw new Error('missing gad7');
  const answers = Object.fromEntries(loaded.file.items.map((item) => [item.id, value]));
  return f.request('POST', `/api/patients/${f.patientId}/scales/gad7/responses`, patient, {
    submissionId: randomUUID(),
    answers,
    functionalAnswer: null,
  });
}

async function doctorCards() {
  return PatientCardsSchema.parse(
    (
      await f.request('GET', `/api/patients/${f.patientId}/cards`, f.doctor.accessToken)
    ).json<unknown>(),
  );
}

describe('GAD-7 band cards (КР457 Приложение Г2)', () => {
  it('creates a warning card for the «Высокий» band (21 points)', async () => {
    expect((await submitAll(3)).statusCode).toBe(201);
    const cards = await doctorCards();
    const card = cards.cards.find((item) => item.ruleId === 'gad7_band_high');
    expect(card).toMatchObject({ severity: 'warning', sourceId: 'kr-457-gtr' });
    expect(card?.facts).toMatchObject({ gad7_band: 'Высокий' });
    expect(card?.message).toContain('Высокий (сумма баллов по ГТР-7 15–21)');
    expect(cards.cards.some((item) => item.ruleId === 'gad7_band_medium')).toBe(false);
  });

  it('creates an info card for the «Средний» band (14 points)', async () => {
    expect((await submitAll(2)).statusCode).toBe(201);
    const cards = await doctorCards();
    const card = cards.cards.find((item) => item.ruleId === 'gad7_band_medium');
    expect(card).toMatchObject({ severity: 'info', sourceId: 'kr-457-gtr' });
    expect(card?.facts).toMatchObject({ gad7_band: 'Средний' });
    expect(cards.cards.some((item) => item.ruleId === 'gad7_band_high')).toBe(false);
  });

  it('creates no band card for «Минимальный» (0 points)', async () => {
    expect((await submitAll(0)).statusCode).toBe(201);
    const cards = await doctorCards();
    expect(cards.cards.some((item) => item.ruleId.startsWith('gad7_band_'))).toBe(false);
  });

  it('keeps the patient out of the cards view', async () => {
    const response = await f.request('GET', `/api/patients/${f.patientId}/cards`, patient);
    expect(response.statusCode).toBe(403);
  });
});
