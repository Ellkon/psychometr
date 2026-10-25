/**
 * Therapy diary contracts (FR-6) and the doctor's registry and timeline (FR-7.1, FR-7.2).
 * The system records what the doctor prescribed; it never suggests a drug or a dose.
 */
import { z } from 'zod';
import { IdSchema } from './access.js';
import { ScaleIdSchema } from './scales.js';

export const DoseTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время в формате ЧЧ:ММ');

/** IANA time zone the dose times are given in (the patient's local time). */
export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'Неизвестный часовой пояс');

const DateSchema = z.iso.date();

export const MedicationInputSchema = z
  .object({
    grlsRegNumber: z.string().trim().min(1).max(100).nullable(),
    drugText: z.string().trim().min(1).max(300),
    doseText: z.string().trim().min(1).max(100),
    doseTimes: z
      .array(DoseTimeSchema)
      .min(1)
      .max(6)
      .refine((times) => new Set(times).size === times.length, 'Время приёма повторяется')
      .transform((times) => [...times].sort()),
    timeZone: TimeZoneSchema,
    startsOn: DateSchema,
    endsOn: DateSchema.nullable(),
  })
  .strict()
  .refine((input) => input.endsOn === null || input.endsOn >= input.startsOn, {
    path: ['endsOn'],
    message: 'Дата окончания раньше даты начала',
  });
export type MedicationInput = z.infer<typeof MedicationInputSchema>;

export const MedicationParamsSchema = z
  .object({ patientId: IdSchema, medicationId: IdSchema })
  .strict();

export const DoseStatusSchema = z.enum(['taken', 'skipped']);
export const DoseMarkInputSchema = z
  .object({ scheduledFor: z.iso.datetime(), status: DoseStatusSchema })
  .strict();
export type DoseMarkInput = z.infer<typeof DoseMarkInputSchema>;

export const AdverseSeveritySchema = z.enum(['mild', 'moderate', 'severe']);
export const AdverseEventInputSchema = z
  .object({
    /** Client-generated per form fill: a retried send stores one record. */
    submissionId: IdSchema,
    description: z.string().trim().min(1).max(1000),
    severity: AdverseSeveritySchema,
    startedOn: DateSchema,
    medicationRequestId: IdSchema.nullable(),
  })
  .strict();
export type AdverseEventInput = z.infer<typeof AdverseEventInputSchema>;

export const DoseSlotSchema = z.object({
  scheduledFor: z.iso.datetime(),
  status: DoseStatusSchema.nullable(),
});
export type DoseSlot = z.infer<typeof DoseSlotSchema>;

/** Share of marked doses among scheduled ones (self-report; not PDC/MPR, FR-6). */
export const AdherenceSchema = z.object({
  periodDays: z.number().int().positive(),
  expected: z.number().int().min(0),
  taken: z.number().int().min(0),
  skipped: z.number().int().min(0),
});

export const MedicationSchema = z.object({
  id: IdSchema,
  grlsRegNumber: z.string().nullable(),
  drugText: z.string(),
  doseText: z.string(),
  doseTimes: z.array(DoseTimeSchema),
  timeZone: z.string(),
  startsOn: DateSchema,
  endsOn: DateSchema.nullable(),
  status: z.enum(['active', 'stopped']),
  createdAt: z.iso.datetime(),
  stoppedAt: z.iso.datetime().nullable(),
  adherence: AdherenceSchema,
  /** Closed slots in a row, newest first, without a "taken" mark. */
  missedInRow: z.number().int().min(0),
  /** Recent and upcoming slots the patient can mark. */
  slots: z.array(DoseSlotSchema),
});
export type Medication = z.infer<typeof MedicationSchema>;

export const AdverseEventSchema = z.object({
  id: IdSchema,
  description: z.string(),
  severity: AdverseSeveritySchema,
  startedOn: DateSchema,
  recordedAt: z.iso.datetime(),
  medicationRequestId: IdSchema.nullable(),
});
export type AdverseEvent = z.infer<typeof AdverseEventSchema>;

export const PatientTherapySchema = z.object({
  medications: z.array(MedicationSchema),
  adverseEvents: z.array(AdverseEventSchema),
});
export type PatientTherapy = z.infer<typeof PatientTherapySchema>;

export const CreatedSchema = z.object({ id: IdSchema });

/** One row of the doctor's registry (FR-7.1, Collaborative Care). */
export const RegistryRowSchema = z.object({
  patientId: IdSchema,
  createdAt: z.iso.datetime(),
  scores: z.array(
    z.object({
      scaleId: ScaleIdSchema,
      score: z.number().int(),
      maxScore: z.number().int(),
      bandLabel: z.string(),
      /** Change against the previous score of the same scale; null for the first one. */
      delta: z.number().int().nullable(),
      answeredAt: z.iso.datetime(),
    }),
  ),
  safetySignal: z.boolean(),
  lastActivityAt: z.iso.datetime().nullable(),
  weeksWithoutContact: z.number().int().min(0).nullable(),
  /** Assigned scales whose completion window is open or missed. */
  dueScales: z.number().int().min(0),
  activeMedications: z.number().int().min(0),
  missedDosesInRow: z.number().int().min(0),
  adverseEventsSinceReview: z.number().int().min(0),
  /** Critical alerts to this doctor that are not acknowledged yet (FR-8). */
  openAlerts: z.number().int().min(0),
  /** The doctor opened the patient after the latest patient activity. */
  reviewed: z.boolean(),
});
export type RegistryRow = z.infer<typeof RegistryRowSchema>;
export const RegistrySchema = z.object({ patients: z.array(RegistryRowSchema) });
export type Registry = z.infer<typeof RegistrySchema>;

const TimelineBase = { at: z.iso.datetime() };
export const TimelineEventSchema = z.discriminatedUnion('kind', [
  z.object({
    ...TimelineBase,
    kind: z.literal('score'),
    scaleId: ScaleIdSchema,
    score: z.number().int(),
    maxScore: z.number().int(),
    bandLabel: z.string(),
    safetySignal: z.boolean(),
  }),
  z.object({
    ...TimelineBase,
    kind: z.enum(['medication_started', 'medication_stopped']),
    drugText: z.string(),
    doseText: z.string(),
  }),
  z.object({
    ...TimelineBase,
    kind: z.literal('dose'),
    drugText: z.string(),
    status: DoseStatusSchema,
    scheduledFor: z.iso.datetime(),
  }),
  z.object({
    ...TimelineBase,
    kind: z.literal('adverse_event'),
    description: z.string(),
    severity: AdverseSeveritySchema,
  }),
  z.object({
    ...TimelineBase,
    kind: z.literal('rule'),
    ruleId: z.string(),
    severity: z.enum(['info', 'warning', 'critical']),
    message: z.string(),
  }),
  z.object({
    ...TimelineBase,
    kind: z.literal('alert'),
    ruleId: z.string(),
    message: z.string(),
    status: z.enum(['pending', 'sent', 'delivered', 'acknowledged']),
    acknowledgedAt: z.iso.datetime().nullable(),
    /** True for the copy sent to a reserve doctor (FR-8.3). */
    escalation: z.boolean(),
  }),
]);
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
export const TimelineSchema = z.object({ events: z.array(TimelineEventSchema) });
export type Timeline = z.infer<typeof TimelineSchema>;
