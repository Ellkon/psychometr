import type { DoseSlot, DrugCatalog, Medication } from '@psychometr/shared';

/** Same windows as the API (apps/api/src/domain/doses.ts): marks up to 1 h early, 48 h late. */
const MARK_EARLY_MS = 60 * 60 * 1000;
const MARK_LATE_MS = 48 * 60 * 60 * 1000;

export const severityLabel = {
  mild: 'Лёгкая',
  moderate: 'Умеренная',
  severe: 'Тяжёлая',
} as const;

export const doseStatusLabel = { taken: 'Принято', skipped: 'Пропущено' } as const;

/** "08:00, 20:00" or "8:00 20:00" → ["08:00", "20:00"]; invalid parts are returned as is. */
export function parseDoseTimes(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((part) => (/^\d:\d{2}$/.test(part) ? `0${part}` : part));
}

export function markableSlots(slots: readonly DoseSlot[], now: number): DoseSlot[] {
  return slots.filter((slot) => {
    const at = Date.parse(slot.scheduledFor);
    return slot.status === null && at <= now + MARK_EARLY_MS && at >= now - MARK_LATE_MS;
  });
}

/** Unmarked doses the patient can mark now, across active prescriptions. */
export function dosesToMark(medications: readonly Medication[], now: number): number {
  return medications
    .filter((medication) => medication.status === 'active')
    .reduce((count, medication) => count + markableSlots(medication.slots, now).length, 0);
}

export function adherenceLabel(medication: Medication): string {
  const { expected, taken, periodDays } = medication.adherence;
  if (expected === 0) return 'Пока нет прошедших доз';
  return `Отмечено как принятые: ${String(taken)} из ${String(expected)} за ${String(periodDays)} дн. (${String(Math.round((taken / expected) * 100))}%)`;
}

export interface DrugOption {
  readonly label: string;
  readonly regNumber: string;
  readonly dosageForms: readonly string[];
}

/** One searchable label per registered product: "Сертралин — Золофт® (ЛП-…)". */
export function drugOptions(catalog: DrugCatalog): DrugOption[] {
  return catalog.products.map((product) => ({
    label: `${product.inn} — ${product.tradeName} (${product.regNumber})`,
    regNumber: product.regNumber,
    dosageForms: product.dosageForms,
  }));
}
