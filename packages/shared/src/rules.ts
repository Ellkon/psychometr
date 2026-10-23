/**
 * Clinical rules (FR-4, FR-5): data in content/rules, evaluated by a decision-table
 * engine on the server. Every rule cites a registered source (AGENTS.md: no source,
 * no rule), and a rule is active only after clinical agreement is recorded.
 */
import { z } from 'zod';
import { IdSchema } from './access.js';

export const RuleIdSchema = z.string().regex(/^[a-z][a-z0-9_]{2,63}$/);
export const RuleSeveritySchema = z.enum(['info', 'warning', 'critical']);
export const RuleStatusSchema = z.enum(['draft', 'active']);

/** A JDM decision graph as exported by the GoRules editor. Validated structurally only. */
export const DecisionGraphSchema = z
  .object({
    contentType: z.string().min(1),
    nodes: z.array(z.object({ id: z.string().min(1), type: z.string().min(1) }).loose()).min(1),
    edges: z.array(
      z
        .object({ id: z.string().min(1), sourceId: z.string().min(1), targetId: z.string().min(1) })
        .loose(),
    ),
  })
  .loose();

export const RuleSchema = z
  .object({
    id: RuleIdSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    status: RuleStatusSchema,
    severity: RuleSeveritySchema,
    source_id: z.string().min(1),
    source_location: z.string().min(1).max(300),
    message: z.string().min(1).max(500),
    suggested_action: z.string().min(1).max(300),
    /** Date of clinical agreement. Required before a rule may be active. */
    reviewed_at: z.iso.date().nullable(),
    decision: DecisionGraphSchema,
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.status === 'active' && rule.reviewed_at === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['reviewed_at'],
        message: 'Активное правило требует даты клинического согласования',
      });
    }
  });
export type Rule = z.infer<typeof RuleSchema>;

export const RuleFileSchema = z
  .object({
    note: z.string().max(500).optional(),
    rules: z.array(RuleSchema),
  })
  .strict();
export type RuleFile = z.infer<typeof RuleFileSchema>;

/** Facts are scalars. Missing clinical information is the string "unknown", never false (FR-4.7). */
export const RuleFactValueSchema = z.union([z.number(), z.boolean(), z.string()]);
export type RuleFactValue = z.infer<typeof RuleFactValueSchema>;

/** Clinical information the system does not store yet; each missing value is a clarification. */
export const CLARIFICATION_FACTS = [
  { key: 'pregnancy', label: 'Беременность' },
  { key: 'renal_function', label: 'Функция почек' },
  { key: 'hepatic_function', label: 'Функция печени' },
  { key: 'concomitant_medications', label: 'Сопутствующие препараты' },
] as const;

export const ClinicalCardSchema = z.object({
  taskId: IdSchema,
  evaluationId: IdSchema,
  ruleId: RuleIdSchema,
  ruleVersion: z.string(),
  severity: RuleSeveritySchema,
  message: z.string(),
  suggestedAction: z.string(),
  sourceId: z.string(),
  sourceLocation: z.string(),
  facts: z.record(z.string(), RuleFactValueSchema),
  triggeredAt: z.iso.datetime(),
  status: z.enum(['requested', 'accepted', 'rejected']),
  comment: z.string().nullable(),
  decidedAt: z.iso.datetime().nullable(),
});
export type ClinicalCard = z.infer<typeof ClinicalCardSchema>;

export const PatientCardsSchema = z.object({
  routing: z.object({
    status: z.enum(['pending_clinical_agreement', 'active']),
    activeRules: z.number().int().min(0),
  }),
  clarifications: z.array(z.object({ key: z.string(), label: z.string() })),
  cards: z.array(ClinicalCardSchema),
});
export type PatientCards = z.infer<typeof PatientCardsSchema>;

export const TaskParamsSchema = z.object({ patientId: IdSchema, taskId: IdSchema }).strict();

export const TaskDecisionInputSchema = z
  .object({
    decision: z.enum(['accepted', 'rejected']),
    comment: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.decision === 'rejected' && !input.comment) {
      ctx.addIssue({
        code: 'custom',
        path: ['comment'],
        message: 'При отклонении укажите комментарий',
      });
    }
  });
export type TaskDecisionInput = z.infer<typeof TaskDecisionInputSchema>;
