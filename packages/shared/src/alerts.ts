import { z } from 'zod';
import { IdSchema } from './access.js';
import { RuleIdSchema } from './rules.js';

/**
 * Doctor alerts (FR-8). Two sources:
 * - `rule`: one per firing of a `critical` rule from content/rules (PHQ-9 item 9 > 0 today).
 *   The text is the rule's message and suggested action. Escalated after ESCALATION_MINUTES.
 * - `adverse_event`: a notification that the patient reported an adverse event (FR-6). Severity
 *   `warning`, never escalated. Owner decision of 2026-10-25: notify only, no clinical threshold;
 *   behaviour graded by severity needs a clinical source (docs/TZ.md, section 12).
 * - `contact_request`: the patient asked the doctor to get in touch (FR-12). `warning`, never
 *   escalated; closed when the doctor records a contact.
 */
export const AlertStatusSchema = z.enum(['pending', 'sent', 'delivered', 'acknowledged']);
export type AlertStatus = z.infer<typeof AlertStatusSchema>;
export const AlertSourceSchema = z.enum(['rule', 'adverse_event', 'contact_request']);
export type AlertSource = z.infer<typeof AlertSourceSchema>;

export const AlertSchema = z
  .object({
    id: IdSchema,
    source: AlertSourceSchema,
    /** Null for an adverse event notification. */
    ruleId: RuleIdSchema.nullable(),
    severity: z.enum(['critical', 'warning']),
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
