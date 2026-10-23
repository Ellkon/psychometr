import { describe, expect, it } from 'vitest';
import type { PatientScales, ScaleDefinition } from '@psychometr/shared';
import { answersComplete, buildSubmission, chartPoints, DEFAULT_SCHEDULE } from './scales.js';
import { EMERGENCY_LINES } from '../components/emergency-instruction.js';

const options = [0, 1, 2, 3].map((value) => ({ value, label: `вариант ${String(value)}` }));
const scale: ScaleDefinition = {
  id: 'demo',
  title: 'Демо',
  version: '1.0.0',
  validationCitation: 'Синтетическая ссылка',
  licenseStatus: 'free_no_permission',
  recallWeeks: 2,
  stem: 'Синтетический стем',
  answerOptions: options,
  items: [
    { id: 'a', text: 'Пункт A' },
    { id: 'b', text: 'Пункт B' },
  ],
  functionalItem: null,
  cutoffs: [{ min: 0, max: 4, label: 'Низкий' }],
  maxScore: 6,
  interpretationNote: 'Пояснение',
  hasSafetyItem: false,
};
const withFunctional: ScaleDefinition = {
  ...scale,
  functionalItem: { id: 'f', text: 'Функция', options: options.slice(0, 2) },
};

describe('scale answers', () => {
  it('requires an integer 0..3 for every scored item', () => {
    expect(answersComplete(scale, { a: 0, b: 3 })).toBe(true);
    expect(answersComplete(scale, { a: 0 })).toBe(false);
    expect(answersComplete(scale, { a: 0, b: 4 })).toBe(false);
    expect(answersComplete(scale, { a: 1.5, b: 0 })).toBe(false);
  });

  it('builds a submission and refuses an incomplete one', () => {
    const id = '7f1c6a52-6b1e-4c3a-9d55-0c8f2b3e9a10';
    expect(buildSubmission(scale, { a: 2, b: 1 }, 5, id)).toEqual({
      submissionId: id,
      answers: { a: 2, b: 1 },
      functionalAnswer: null,
    });
    expect(buildSubmission(withFunctional, { a: 2, b: 1 }, 1, id)).toEqual({
      submissionId: id,
      answers: { a: 2, b: 1 },
      functionalAnswer: 1,
    });
    expect(
      buildSubmission(withFunctional, { a: 2, b: 1 }, undefined, id).functionalAnswer,
    ).toBeNull();
    expect(() => buildSubmission(scale, { a: 2 }, undefined, id)).toThrow('пункт b');
  });
});

describe('scale history and schedule', () => {
  const history: PatientScales['history'] = [
    {
      responseId: crypto.randomUUID(),
      scaleId: 'demo',
      scaleTitle: 'Демо',
      score: 4,
      maxScore: 6,
      bandLabel: 'Низкий',
      safetySignal: false,
      answeredAt: '2026-10-10T10:00:00.000Z',
    },
    {
      responseId: crypto.randomUUID(),
      scaleId: 'other',
      scaleTitle: 'Другая',
      score: 9,
      maxScore: 27,
      bandLabel: 'Высокий',
      safetySignal: true,
      answeredAt: '2026-10-11T10:00:00.000Z',
    },
    {
      responseId: crypto.randomUUID(),
      scaleId: 'demo',
      scaleTitle: 'Демо',
      score: 2,
      maxScore: 6,
      bandLabel: 'Низкий',
      safetySignal: false,
      answeredAt: '2026-10-01T10:00:00.000Z',
    },
  ];

  it('returns one scale history in chronological order', () => {
    const points = chartPoints(history, 'demo');
    expect(points.map((point) => point.score)).toEqual([2, 4]);
    expect(points[0]?.time).toBeLessThan(points[1]?.time ?? 0);
  });

  it('uses the two-week default schedule from the TZ', () => {
    expect(DEFAULT_SCHEDULE).toEqual({ intervalDays: 14, windowDays: 7, active: true });
  });
});

describe('emergency instruction', () => {
  it('keeps the approved text verbatim', () => {
    expect(EMERGENCY_LINES).toEqual([
      'Вы не одиноки, и вам можно помочь.',
      'Если вы боитесь причинить себе вред прямо сейчас — звоните 112 или 103.',
      'Телефон горячей линии психологической помощи МЧС - +7 (495) 989-50-50',
      'Постарайтесь сейчас не оставаться в одиночестве',
    ]);
  });
});
