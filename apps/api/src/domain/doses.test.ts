import { describe, expect, it } from 'vitest';
import {
  doseSlots,
  isMarkableSlot,
  localDate,
  summarizeDoses,
  zonedInstant,
  type DoseSchedule,
  type DoseStatus,
} from './doses.js';

const schedule = (overrides: Partial<DoseSchedule> = {}): DoseSchedule => ({
  doseTimes: ['08:00', '20:00'],
  timeZone: 'Europe/Moscow',
  startsOn: '2026-10-01',
  endsOn: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  stoppedAt: null,
  ...overrides,
});

describe('time zones', () => {
  it('converts local intake times to UTC, including across a DST change', () => {
    expect(zonedInstant('2026-10-23', '08:00', 'Europe/Moscow').toISOString()).toBe(
      '2026-10-23T05:00:00.000Z',
    );
    expect(zonedInstant('2026-03-28', '08:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-03-28T07:00:00.000Z',
    );
    expect(zonedInstant('2026-03-30', '08:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-03-30T06:00:00.000Z',
    );
    expect(localDate(new Date('2026-10-23T22:30:00Z'), 'Asia/Vladivostok')).toBe('2026-10-24');
  });
});

describe('dose slots', () => {
  it('lists slots only inside the diary period', () => {
    const slots = doseSlots(
      schedule({ createdAt: new Date('2026-10-01T10:00:00Z'), endsOn: '2026-10-02' }),
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-12-01T00:00:00Z'),
    );
    // 01.10 08:00 MSK is before the prescription was recorded; 01.10 20:00, 02.10 twice.
    expect(slots.map((slot) => slot.toISOString())).toEqual([
      '2026-10-01T17:00:00.000Z',
      '2026-10-02T05:00:00.000Z',
      '2026-10-02T17:00:00.000Z',
    ]);
  });

  it('stops counting when the prescription is stopped', () => {
    const slots = doseSlots(
      schedule({ stoppedAt: new Date('2026-10-02T06:00:00Z') }),
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-10-05T00:00:00Z'),
    );
    expect(slots).toHaveLength(3);
  });
});

describe('dose summary', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const at = (iso: string) => new Date(iso).getTime();

  it('counts marks over closed slots and the current run without a taken dose', () => {
    const marks = new Map<number, DoseStatus>([
      [at('2026-10-04T05:00:00Z'), 'taken'],
      [at('2026-10-04T17:00:00Z'), 'skipped'],
    ]);
    const summary = summarizeDoses(schedule(), marks, now);
    // Closed slots up to 10:00Z on 05.10: 01.10–04.10 twice a day + 05.10 05:00Z = 9.
    expect(summary.adherence).toEqual({ periodDays: 30, expected: 9, taken: 1, skipped: 1 });
    // 04.10 20:00 skipped and 05.10 08:00 unmarked.
    expect(summary.missedInRow).toBe(2);
    expect(summary.slots.find((slot) => slot.scheduledFor === '2026-10-04T05:00:00.000Z')).toEqual({
      scheduledFor: '2026-10-04T05:00:00.000Z',
      status: 'taken',
    });
  });

  it('accepts marks only for real slots close to now', () => {
    expect(isMarkableSlot(schedule(), new Date('2026-10-05T05:00:00Z'), now)).toBe(true);
    expect(isMarkableSlot(schedule(), new Date('2026-10-05T05:30:00Z'), now)).toBe(false);
    expect(isMarkableSlot(schedule(), new Date('2026-10-05T17:00:00Z'), now)).toBe(false);
    expect(isMarkableSlot(schedule(), new Date('2026-10-01T05:00:00Z'), now)).toBe(false);
  });
});
