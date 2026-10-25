import { z } from 'zod';
import { IdSchema } from './access.js';
import { RuleIdSchema } from './rules.js';

/**
 * Critical alerts (FR-8): one per firing of a `critical` rule from content/rules
 * (PHQ-9 item 9 > 0 today). The text is the rule's message and suggested action.
 */
export const AlertStatusSchema = z.enum(['pending', 'sent', 'delivered', 'acknowledged']);
export type AlertStatus = z.infer<typeof AlertStatusSchema>;

export const AlertSchema = z
  .object({
    id: IdSchema,
    ruleId: RuleIdSchema,
    severity: z.literal('critical'),
    patientId: IdSchema,
    patientName: z.string(),
    message: z.string(),
    suggestedAction: z.string(),
    status: AlertStatusSchema,
    createdAt: z.iso.datetime({ offset: true }),
    acknowledgedAt: z.iso.datetime({ offset: true }).nullable(),
    /** Set when this alert is the escalation copy for a reserve doctor (FR-8.3). */
    escalatedFrom: IdSchema.nullable(),
  })
  .strict();
export type Alert = z.infer<typeof AlertSchema>;

export const AlertListSchema = z.object({ alerts: z.array(AlertSchema) }).strict();
export const AlertParamsSchema = z.object({ alertId: IdSchema }).strict();

/** Client → server over the WebSocket. The token travels in the first message, never in the URL. */
export const AlertSocketClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(1).max(4096) }).strict(),
  z.object({ type: z.literal('received'), alertId: IdSchema }).strict(),
]);
export type AlertSocketClientMessage = z.infer<typeof AlertSocketClientMessageSchema>;

/** Server → client over the WebSocket. */
export const AlertSocketServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }).strict(),
  z.object({ type: z.literal('alert'), alert: AlertSchema }).strict(),
]);
export type AlertSocketServerMessage = z.infer<typeof AlertSocketServerMessageSchema>;

/** Escalation timer for an unacknowledged critical alert (FR-8.3). */
export const ESCALATION_MINUTES = 30;
