import type {
  PatientScales,
  ScaleDefinition,
  ScaleScheduleInput,
  ScaleSubmission,
} from '@psychometr/shared';

/** Default schedule from FR-3.4: every two weeks, seven-day completion window. */
export const DEFAULT_SCHEDULE: ScaleScheduleInput = {
  intervalDays: 14,
  windowDays: 7,
  active: true,
};

export const scheduleStatusLabel: Record<PatientScales['schedules'][number]['status'], string> = {
  scheduled: 'Запланирована',
  due: 'Пора заполнить',
  overdue: 'Просрочена',
  paused: 'Приостановлена',
};

/** True when every scored item has an answer in 0..3 (the functional item is optional). */
export function answersComplete(
  scale: ScaleDefinition,
  answers: Readonly<Record<string, number | undefined>>,
): boolean {
  return scale.items.every((item) => {
    const value = answers[item.id];
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3;
  });
}

export function buildSubmission(
  scale: ScaleDefinition,
  answers: Readonly<Record<string, number | undefined>>,
  functionalAnswer: number | undefined,
  submissionId: string,
): ScaleSubmission {
  const scored: Record<string, number> = {};
  for (const item of scale.items) {
    const value = answers[item.id];
    if (value === undefined) throw new Error(`Не отвечен пункт ${item.id}`);
    scored[item.id] = value;
  }
  return {
    submissionId,
    answers: scored,
    functionalAnswer: scale.functionalItem ? (functionalAnswer ?? null) : null,
  };
}

export interface ChartPoint {
  readonly time: number;
  readonly score: number;
  readonly label: string;
}

/** Score history of one scale in chronological order, ready for a time axis. */
export function chartPoints(history: PatientScales['history'], scaleId: string): ChartPoint[] {
  return history
    .filter((row) => row.scaleId === scaleId)
    .map((row) => ({
      time: Date.parse(row.answeredAt),
      score: row.score,
      label: new Date(row.answeredAt).toLocaleDateString('ru-RU'),
    }))
    .sort((a, b) => a.time - b.time);
}
