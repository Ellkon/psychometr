import { CLARIFICATION_FACTS } from '@psychometr/shared';

export const FACT_LABEL: ReadonlyMap<string, string> = new Map<string, string>([
  ['phq9_total', 'PHQ-9, сумма баллов'],
  ['phq9_band', 'PHQ-9, степень'],
  ['phq9_item9_positive', 'PHQ-9, пункт 9 больше 0'],
  ['gad7_total', 'GAD-7, сумма баллов'],
  ['gad7_band', 'GAD-7, степень'],
  ...CLARIFICATION_FACTS.map((fact): [string, string] => [fact.key, fact.label]),
]);

/** "unknown" is shown as missing data, never as "нет" (FR-4.7). */
export function formatFact(value: string | number | boolean): string {
  if (value === 'unknown') return 'не указано, уточнить';
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  return String(value);
}
