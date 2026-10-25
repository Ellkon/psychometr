import {
  adverseSeverityLabel,
  type DoseSlot,
  type DrugCatalog,
  type Medication,
} from '@psychometr/shared';

/** Same windows as the API (apps/api/src/domain/doses.ts): marks up to 1 h early, 48 h late. */
const MARK_EARLY_MS = 60 * 60 * 1000;
const MARK_LATE_MS = 48 * 60 * 60 * 1000;

export const severityLabel = adverseSeverityLabel;

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
  readonly dosageForm: string;
  /** Strength of a solid form ("20 мг"), offered as the starting dose; empty otherwise. */
  readonly strength: string;
  readonly featured: boolean;
}

/** "таблетки, покрытые пленочной оболочкой, 20 мг" → "20 мг"; solutions ("5 мг/мл") → "". */
export function strengthOf(dosageForm: string): string {
  return /, (\d[\d.,]*\s*(?:мг|мкг|г))$/.exec(dosageForm)?.[1] ?? '';
}

/**
 * One searchable label per product and dosage form: "АВИАНДР® (таблетки…, 20 мг) — Маритупирдин".
 * The INN is dropped when it repeats the trade name; generics that still collide get the
 * registration number, so each label maps to one product.
 */
export function drugOptions(catalog: DrugCatalog): DrugOption[] {
  const options = catalog.products.flatMap((product) =>
    product.dosageForms.map((dosageForm) => {
      const sameName =
        product.tradeName.replace(/®/g, '').trim().toLowerCase() === product.inn.toLowerCase();
      return {
        label: `${product.tradeName} (${dosageForm})${sameName ? '' : ` — ${product.inn}`}`,
        regNumber: product.regNumber,
        dosageForm,
        strength: strengthOf(dosageForm),
        featured: product.featured,
      };
    }),
  );
  const counts = new Map<string, number>();
  for (const option of options) counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
  const seen = new Set<string>();
  return options
    .map((option) =>
      (counts.get(option.label) ?? 0) > 1
        ? { ...option, label: `${option.label} · ${option.regNumber}` }
        : option,
    )
    .filter((option) => !seen.has(option.label) && Boolean(seen.add(option.label)));
}
