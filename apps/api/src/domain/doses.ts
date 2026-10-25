/**
 * Dose slots of a prescription (FR-6): pure time arithmetic, no database access.
 * A slot is one local intake time on one local date in the prescription's time zone.
 */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Adherence is counted over this many days (FR-6 "за период"). */
export const ADHERENCE_DAYS = 30;
/** A slot without a mark is counted as not taken once this much time has passed. */
export const DOSE_GRACE_MS = 2 * HOUR_MS;
/** The patient may mark a slot this long after it and this long before it. */
export const MARK_LATE_MS = 48 * HOUR_MS;
export const MARK_EARLY_MS = HOUR_MS;
/** Upcoming slots shown to the patient. */
const SLOTS_AHEAD_MS = 24 * HOUR_MS;

export interface DoseSchedule {
  readonly doseTimes: readonly string[];
  readonly timeZone: string;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly createdAt: Date;
  readonly stoppedAt: Date | null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, format);
  }
  return format;
}

function localParts(instant: number, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant)))
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return parts as { year: number; month: number; day: number; hour: number; minute: number };
}

function offsetMs(instant: number, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(instant / 60_000) * 60_000;
}

/** Local date "YYYY-MM-DD" and time "HH:MM" in a zone → UTC instant. */
export function zonedInstant(date: string, time: string, timeZone: string): Date {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMs(guess, timeZone);
  return new Date(guess - offsetMs(first, timeZone));
}

/** Local calendar date of an instant in a zone. */
export function localDate(instant: Date, timeZone: string): string {
  const p = localParts(instant.getTime(), timeZone);
  return `${String(p.year)}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Slots within [from, to]. Only the time the diary covers counts: from the moment the
 * prescription was recorded until it was stopped, inside its start and end dates.
 */
export function doseSlots(schedule: DoseSchedule, from: Date, to: Date): Date[] {
  const start = Math.max(from.getTime(), schedule.createdAt.getTime());
  const end = Math.min(to.getTime(), schedule.stoppedAt?.getTime() ?? Infinity);
  if (start > end) return [];
  let date = localDate(new Date(start - DAY_MS), schedule.timeZone);
  if (date < schedule.startsOn) date = schedule.startsOn;
  let last = localDate(new Date(end + DAY_MS), schedule.timeZone);
  if (schedule.endsOn && last > schedule.endsOn) last = schedule.endsOn;
  const slots: Date[] = [];
  for (; date <= last; date = addDays(date, 1)) {
    for (const time of schedule.doseTimes) {
      const slot = zonedInstant(date, time, schedule.timeZone);
      if (slot.getTime() >= start && slot.getTime() <= end) slots.push(slot);
    }
  }
  return slots.sort((a, b) => a.getTime() - b.getTime());
}

export type DoseStatus = 'taken' | 'skipped';

export interface DoseSummary {
  readonly adherence: { periodDays: number; expected: number; taken: number; skipped: number };
  readonly missedInRow: number;
  readonly slots: { scheduledFor: string; status: DoseStatus | null }[];
}

/** Adherence over the period, the current run of not-taken doses and the markable slots. */
export function summarizeDoses(
  schedule: DoseSchedule,
  marks: ReadonlyMap<number, DoseStatus>,
  now: Date,
): DoseSummary {
  const closed = doseSlots(
    schedule,
    new Date(now.getTime() - ADHERENCE_DAYS * DAY_MS),
    new Date(now.getTime() - DOSE_GRACE_MS),
  );
  let taken = 0,
    skipped = 0;
  for (const slot of closed) {
    const status = marks.get(slot.getTime());
    if (status === 'taken') taken++;
    else if (status === 'skipped') skipped++;
  }
  let missedInRow = 0;
  for (const slot of [...closed].reverse()) {
    if (marks.get(slot.getTime()) === 'taken') break;
    missedInRow++;
  }
  const visible = doseSlots(
    schedule,
    new Date(now.getTime() - MARK_LATE_MS),
    new Date(now.getTime() + SLOTS_AHEAD_MS),
  );
  return {
    adherence: { periodDays: ADHERENCE_DAYS, expected: closed.length, taken, skipped },
    missedInRow,
    slots: visible.map((slot) => ({
      scheduledFor: slot.toISOString(),
      status: marks.get(slot.getTime()) ?? null,
    })),
  };
}

/** True when the instant is a slot of the schedule that the patient may mark now. */
export function isMarkableSlot(schedule: DoseSchedule, slot: Date, now: Date): boolean {
  if (slot.getTime() > now.getTime() + MARK_EARLY_MS) return false;
  if (slot.getTime() < now.getTime() - MARK_LATE_MS) return false;
  return doseSlots(schedule, slot, slot).some(
    (candidate) => candidate.getTime() === slot.getTime(),
  );
}
