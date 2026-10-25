import { describe, expect, it } from 'vitest';
import type { Medication } from '@psychometr/shared';
import {
  adherenceLabel,
  dosesToMark,
  drugOptions,
  strengthOf,
  markableSlots,
  parseDoseTimes,
} from './therapy.js';

const now = Date.parse('2026-10-23T12:00:00Z');
const medication = (overrides: Partial<Medication> = {}): Medication => ({
  id: '7f1c6a52-6b1e-4c3a-9d55-0c8f2b3e9a10',
  grlsRegNumber: null,
  drugText: 'Препарат',
  doseText: '50 мг',
  doseTimes: ['08:00'],
  timeZone: 'UTC',
  startsOn: '2026-10-01',
  endsOn: null,
  status: 'active',
  createdAt: '2026-10-01T00:00:00.000Z',
  stoppedAt: null,
  adherence: { periodDays: 30, expected: 4, taken: 3, skipped: 1 },
  missedInRow: 0,
  slots: [
    { scheduledFor: '2026-10-21T08:00:00.000Z', status: null },
    { scheduledFor: '2026-10-22T08:00:00.000Z', status: 'taken' },
    { scheduledFor: '2026-10-23T08:00:00.000Z', status: null },
    { scheduledFor: '2026-10-24T08:00:00.000Z', status: null },
  ],
  ...overrides,
});

describe('therapy helpers', () => {
  it('normalizes typed intake times', () => {
    expect(parseDoseTimes('8:00, 20:00')).toEqual(['08:00', '20:00']);
    expect(parseDoseTimes(' 09:30;21:15 ')).toEqual(['09:30', '21:15']);
  });

  it('offers only unmarked slots inside the marking window', () => {
    expect(markableSlots(medication().slots, now).map((slot) => slot.scheduledFor)).toEqual([
      '2026-10-23T08:00:00.000Z',
    ]);
    expect(dosesToMark([medication(), medication({ status: 'stopped' })], now)).toBe(1);
  });

  it('describes adherence as marked doses, not as PDC', () => {
    expect(adherenceLabel(medication())).toBe('Отмечено как принятые: 3 из 4 за 30 дн. (75%)');
    expect(
      adherenceLabel(
        medication({ adherence: { periodDays: 30, expected: 0, taken: 0, skipped: 0 } }),
      ),
    ).toBe('Пока нет прошедших доз');
  });

  it('labels one option per dosage form, with the form in brackets and the INN after', () => {
    const options = drugOptions({
      exportDate: '2026-10-23',
      products: [
        {
          regNumber: 'ЛП-1',
          tradeName: 'Золофт®',
          inn: 'Сертралин',
          dosageForms: ['таблетки, покрытые пленочной оболочкой, 50 мг', 'таблетки, 100 мг'],
          featured: false,
        },
      ],
    });
    expect(options.map((option) => [option.label, option.strength])).toEqual([
      ['Золофт® (таблетки, покрытые пленочной оболочкой, 50 мг) — Сертралин', '50 мг'],
      ['Золофт® (таблетки, 100 мг) — Сертралин', '100 мг'],
    ]);
  });

  it('drops a repeated INN and tells colliding generics apart by registration number', () => {
    const generic = (regNumber: string) => ({
      regNumber,
      tradeName: 'Агомелатин',
      inn: 'Агомелатин',
      dosageForms: ['таблетки, 25 мг'],
      featured: false,
    });
    expect(
      drugOptions({ exportDate: '2026-10-23', products: [generic('ЛП-1'), generic('ЛП-2')] }).map(
        (option) => option.label,
      ),
    ).toEqual(['Агомелатин (таблетки, 25 мг) · ЛП-1', 'Агомелатин (таблетки, 25 мг) · ЛП-2']);
  });

  it('offers a starting dose only for solid forms, not for concentrations', () => {
    expect(strengthOf('таблетки, покрытые пленочной оболочкой, 20 мг')).toBe('20 мг');
    expect(strengthOf('раствор для внутримышечного введения, 5 мг/мл, 5 мл')).toBe('');
    expect(strengthOf('- Без рецепта')).toBe('');
  });
});
