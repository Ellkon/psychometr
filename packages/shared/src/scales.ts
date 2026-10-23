/**
 * Questionnaire (scale) contracts: content file format (content/scales/*.json),
 * public API shapes and patient submissions. Scoring lives in apps/api only.
 */
import { z } from 'zod';
import { IdSchema } from './access.js';

export const ScaleIdSchema = z.string().regex(/^[a-z][a-z0-9]{1,31}$/);
export const ItemIdSchema = z.string().regex(/^[a-z0-9_]{1,40}$/);
/** Every scale in this stage uses 0..3 answers (AGENTS.md: text is copied verbatim). */
export const ANSWER_MAX = 3;
const AnswerValueSchema = z.number().int().min(0).max(ANSWER_MAX);

const AnswerOptionSchema = z.object({
  value: AnswerValueSchema,
  label: z.string().min(1).max(200),
});
const ItemSchema = z.object({
  id: ItemIdSchema,
  text: z.string().min(1).max(1000),
});
const BandSchema = z.object({
  min: z.number().int().min(0),
  max: z.number().int().min(0),
  label: z.string().min(1).max(100),
});
const FunctionalItemSchema = z.object({
  id: ItemIdSchema,
  text: z.string().min(1).max(1000),
  options: z.array(AnswerOptionSchema).min(2).max(4),
});

/** Content file: content/scales/<id>.ru.json. Strict: unknown keys are rejected. */
export const ScaleFileSchema = z
  .object({
    passport: z
      .object({
        id: ScaleIdSchema,
        title: z.string().min(1).max(200),
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
        validation_citation_ru: z.string().min(1).max(2000),
        source_ids: z.array(z.string().min(1)).min(1),
        text_source_id: z.string().min(1),
        text_location: z.string().min(1).max(300),
        /** Only confirmed licenses are loadable (FR-3.6). */
        license_status: z.enum(['free_no_permission', 'licensed']),
        license_source_id: z.string().min(1),
        recall_period: z.object({ weeks: z.number().int().min(1).max(52) }).strict(),
        /** Set by a clinician after review; null until then. */
        reviewed_at: z.iso.date().nullable(),
      })
      .strict(),
    stem: z.string().min(1).max(500),
    answer_options: z.array(AnswerOptionSchema).min(2).max(4),
    items: z.array(ItemSchema).min(1).max(30),
    functional_item: FunctionalItemSchema.nullable(),
    cutoffs: z.array(BandSchema).min(1),
    interpretation_note: z.string().min(1).max(1000),
    safety_item: z
      .object({
        item_id: ItemIdSchema,
        positive_above: z.number().int().min(0),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((scale, ctx) => {
    const sequential = (values: number[]) => values.every((value, index) => value === index);
    const optionValues = scale.answer_options.map((option) => option.value);
    if (!sequential(optionValues))
      ctx.addIssue({ code: 'custom', message: 'answer_options must be 0..n-1 in order' });
    if (scale.answer_options.length - 1 !== ANSWER_MAX)
      ctx.addIssue({ code: 'custom', message: 'answer scale must use 0..3' });
    const ids = scale.items.map((item) => item.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'item ids must be unique' });
    if (scale.functional_item) {
      if (ids.includes(scale.functional_item.id))
        ctx.addIssue({ code: 'custom', message: 'functional item id clashes with an item' });
      if (!sequential(scale.functional_item.options.map((option) => option.value)))
        ctx.addIssue({ code: 'custom', message: 'functional options must be 0..n-1 in order' });
    }
    if (scale.safety_item && !ids.includes(scale.safety_item.item_id))
      ctx.addIssue({ code: 'custom', message: 'safety item must reference a scored item' });
    // Bands must cover 0..maxScore without gaps or overlaps.
    const maxScore = scale.items.length * ANSWER_MAX;
    const bands = scale.cutoffs;
    const first = bands[0];
    const last = bands[bands.length - 1];
    const contiguous = bands.every((band, index) => {
      if (band.min > band.max) return false;
      if (index === 0) return true;
      const previous = bands[index - 1];
      return previous !== undefined && band.min === previous.max + 1;
    });
    if (!first || first.min !== 0 || !last || last.max !== maxScore || !contiguous)
      ctx.addIssue({
        code: 'custom',
        message: `cutoffs must cover 0..${String(maxScore)} without gaps`,
      });
  });
export type ScaleFile = z.infer<typeof ScaleFileSchema>;

/** Public view of a scale for the UI. Built by the API from a validated ScaleFile. */
export const ScaleDefinitionSchema = z.object({
  id: ScaleIdSchema,
  title: z.string(),
  version: z.string(),
  validationCitation: z.string(),
  licenseStatus: z.enum(['free_no_permission', 'licensed']),
  recallWeeks: z.number().int(),
  stem: z.string(),
  answerOptions: z.array(z.object({ value: z.number().int(), label: z.string() })),
  items: z.array(z.object({ id: z.string(), text: z.string() })),
  functionalItem: z
    .object({
      id: z.string(),
      text: z.string(),
      options: z.array(z.object({ value: z.number().int(), label: z.string() })),
    })
    .nullable(),
  cutoffs: z.array(z.object({ min: z.number().int(), max: z.number().int(), label: z.string() })),
  maxScore: z.number().int(),
  interpretationNote: z.string(),
  hasSafetyItem: z.boolean(),
});
export type ScaleDefinition = z.infer<typeof ScaleDefinitionSchema>;
export const ScaleCatalogSchema = z.object({ scales: z.array(ScaleDefinitionSchema) });

/** Patient submission. Item-level validity (all ids present, nothing extra) is checked against the scale. */
export const ScaleSubmissionSchema = z
  .object({
    /** Client-generated per form fill: a retried or duplicated send stores one response. */
    submissionId: IdSchema,
    answers: z.record(ItemIdSchema, AnswerValueSchema),
    functionalAnswer: AnswerValueSchema.nullable(),
  })
  .strict();
export type ScaleSubmission = z.infer<typeof ScaleSubmissionSchema>;

export const ScaleParamsSchema = z.object({ patientId: IdSchema, scaleId: ScaleIdSchema }).strict();

export const ScaleResultSchema = z.object({
  responseId: IdSchema,
  scaleId: ScaleIdSchema,
  score: z.number().int().min(0),
  maxScore: z.number().int().min(0),
  bandLabel: z.string(),
  safetySignal: z.boolean(),
  answeredAt: z.iso.datetime(),
});
export type ScaleResult = z.infer<typeof ScaleResultSchema>;

export const ScheduleStatusSchema = z.enum(['paused', 'scheduled', 'due', 'overdue']);
export const ScaleScheduleInputSchema = z
  .object({
    intervalDays: z.number().int().min(1).max(365),
    windowDays: z.number().int().min(1).max(90),
    active: z.boolean(),
  })
  .strict();
export type ScaleScheduleInput = z.infer<typeof ScaleScheduleInputSchema>;

export const PatientScalesSchema = z.object({
  schedules: z.array(
    z.object({
      scaleId: ScaleIdSchema,
      title: z.string(),
      intervalDays: z.number().int(),
      windowDays: z.number().int(),
      active: z.boolean(),
      status: ScheduleStatusSchema,
      dueAt: z.iso.datetime(),
      lastAnsweredAt: z.iso.datetime().nullable(),
    }),
  ),
  history: z.array(
    z.object({
      responseId: IdSchema,
      scaleId: ScaleIdSchema,
      scaleTitle: z.string(),
      score: z.number().int(),
      maxScore: z.number().int(),
      bandLabel: z.string(),
      safetySignal: z.boolean(),
      answeredAt: z.iso.datetime(),
    }),
  ),
});
export type PatientScales = z.infer<typeof PatientScalesSchema>;
