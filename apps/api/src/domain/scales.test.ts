import { describe, expect, it } from 'vitest';
import { ScaleFileSchema, type ScaleFile } from '@psychometr/shared';
import { loadScaleCatalog, scheduleStatus, scoreScale, validateSubmission } from './scales.js';
import { DomainError } from './errors.js';

const DAY = 24 * 60 * 60 * 1000;

const catalogPromise = loadScaleCatalog();
async function scale(id: 'phq9' | 'gad7'): Promise<ScaleFile> {
  const loaded = (await catalogPromise).scales.get(id);
  if (!loaded) throw new Error(`missing ${id}`);
  return loaded.file;
}
function answers(ids: string[], value: number): Record<string, number> {
  return Object.fromEntries(ids.map((id) => [id, value]));
}

describe('content loading', () => {
  it('loads exactly the two stage-3 scales with confirmed licenses', async () => {
    const catalog = await catalogPromise;
    expect([...catalog.scales.keys()].sort()).toEqual(['gad7', 'phq9']);
    for (const { definition } of catalog.scales.values()) {
      expect(definition.licenseStatus).toBe('free_no_permission');
      expect(definition.recallWeeks).toBe(2);
    }
  });

  it('exposes PHQ-9 item 9 as the safety item and GAD-7 without one', async () => {
    const phq = (await catalogPromise).scales.get('phq9');
    const gad = (await catalogPromise).scales.get('gad7');
    expect(phq?.definition.maxScore).toBe(27);
    expect(phq?.definition.hasSafetyItem).toBe(true);
    expect(phq?.definition.functionalItem).not.toBeNull();
    expect(gad?.definition.maxScore).toBe(21);
    expect(gad?.definition.hasSafetyItem).toBe(false);
    expect(gad?.definition.functionalItem).toBeNull();
  });

  it('rejects a scale whose bands leave a gap or do not reach the maximum', async () => {
    const valid = await scale('gad7');
    const withGap = structuredClone(valid);
    withGap.cutoffs[1] = { min: 6, max: 9, label: 'Умеренный' };
    expect(ScaleFileSchema.safeParse(withGap).success).toBe(false);
    const shortMax = structuredClone(valid);
    shortMax.cutoffs[3] = { min: 15, max: 20, label: 'Высокий' };
    expect(ScaleFileSchema.safeParse(shortMax).success).toBe(false);
  });

  it('rejects unlicensed scales (FR-3.6) and unknown keys', async () => {
    const valid = await scale('phq9');
    const pending = structuredClone(valid);
    (pending.passport as { license_status: string }).license_status = 'pending';
    expect(ScaleFileSchema.safeParse(pending).success).toBe(false);
    expect(ScaleFileSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});

describe('PHQ-9 scoring', () => {
  it.each([
    [0, 'Менее 5 баллов'],
    [4, 'Менее 5 баллов'],
    [5, 'Лёгкая'],
    [9, 'Лёгкая'],
    [10, 'Умеренная'],
    [14, 'Умеренная'],
    [15, 'Умеренно тяжёлая'],
    [19, 'Умеренно тяжёлая'],
    [20, 'Тяжёлая'],
    [27, 'Тяжёлая'],
  ])('total %i falls into band "%s"', async (total, label) => {
    const file = await scale('phq9');
    // Distribute the total over nine items with each item at most 3.
    const ids = file.items.map((item) => item.id);
    const values: Record<string, number> = {};
    let left = total;
    for (const id of ids) {
      const value = Math.min(3, left);
      Object.assign(values, { [id]: value });
      left -= value;
    }
    const result = scoreScale(file, values);
    expect(result.score).toBe(total);
    expect(result.maxScore).toBe(27);
    expect(result.bandLabel).toBe(label);
  });

  it('flags item 9 greater than zero as a safety signal, regardless of total', async () => {
    const file = await scale('phq9');
    const values = answers(
      file.items.map((item) => item.id),
      0,
    );
    values['phq9_09'] = 1;
    const result = scoreScale(file, values);
    expect(result.score).toBe(1);
    expect(result.safetySignal).toBe(true);
    values['phq9_09'] = 0;
    expect(scoreScale(file, values).safetySignal).toBe(false);
  });
});

describe('GAD-7 scoring', () => {
  it.each([
    [0, 'Минимальный'],
    [4, 'Минимальный'],
    [5, 'Умеренный'],
    [9, 'Умеренный'],
    [10, 'Средний'],
    [14, 'Средний'],
    [15, 'Высокий'],
    [21, 'Высокий'],
  ])('total %i is "%s" as in КР 457', async (total, label) => {
    const file = await scale('gad7');
    const ids = file.items.map((item) => item.id);
    const values: Record<string, number> = {};
    let left = total;
    for (const id of ids) {
      const value = Math.min(3, left);
      Object.assign(values, { [id]: value });
      left -= value;
    }
    const result = scoreScale(file, values);
    expect(result.score).toBe(total);
    expect(result.maxScore).toBe(21);
    expect(result.bandLabel).toBe(label);
    expect(result.safetySignal).toBe(false);
  });
});

describe('submission validation', () => {
  it('requires every scored item and nothing else', async () => {
    const file = await scale('gad7');
    const ids = file.items.map((item) => item.id);
    const complete = { answers: answers(ids, 1), functionalAnswer: null };
    expect(() => {
      validateSubmission(file, complete);
    }).not.toThrow();
    const missing = { answers: answers(ids.slice(1), 1), functionalAnswer: null };
    expect(() => {
      validateSubmission(file, missing);
    }).toThrow(DomainError);
    const extra = { answers: { ...answers(ids, 1), not_an_item: 1 }, functionalAnswer: null };
    expect(() => {
      validateSubmission(file, extra);
    }).toThrow(DomainError);
    const functional = { answers: answers(ids, 1), functionalAnswer: 2 };
    expect(() => {
      validateSubmission(file, functional);
    }).toThrow(DomainError);
  });

  it('accepts the optional PHQ-9 functional answer only as null or 0..3', async () => {
    const file = await scale('phq9');
    const ids = file.items.map((item) => item.id);
    expect(() => {
      validateSubmission(file, { answers: answers(ids, 0), functionalAnswer: 2 });
    }).not.toThrow();
    expect(() => {
      validateSubmission(file, { answers: answers(ids, 0), functionalAnswer: null });
    }).not.toThrow();
  });
});

describe('schedule status (FR-3.4)', () => {
  const startsAt = new Date('2026-10-01T00:00:00Z');
  const base = { active: true, intervalDays: 14, windowDays: 7, startsAt };

  it('is due at the start if never answered, then overdue after the window', () => {
    expect(scheduleStatus(base, null, new Date(startsAt.getTime() - DAY)).status).toBe('scheduled');
    expect(scheduleStatus(base, null, startsAt).status).toBe('due');
    expect(scheduleStatus(base, null, new Date(startsAt.getTime() + 8 * DAY)).status).toBe(
      'overdue',
    );
  });

  it('counts the next due date from the last answer', () => {
    const answered = new Date('2026-10-10T00:00:00Z');
    const state = scheduleStatus(base, answered, new Date('2026-10-20T00:00:00Z'));
    expect(state.status).toBe('scheduled');
    expect(state.dueAt.toISOString()).toBe('2026-10-24T00:00:00.000Z');
    expect(scheduleStatus(base, answered, new Date('2026-10-30T00:00:00Z')).status).toBe('due');
  });

  it('pauses inactive schedules', () => {
    expect(scheduleStatus({ ...base, active: false }, null, new Date('2030-01-01')).status).toBe(
      'paused',
    );
  });
});
