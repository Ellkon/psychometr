import { z } from 'zod';
import { IdSchema } from './access.js';

/**
 * Runtime security signals for the administrator (NFR-2): a spike of access denials or a
 * series of failed passwords and invitation codes. Counts only, no personal or clinical data.
 */
export const SecuritySignalKindSchema = z.enum(['access_denied_spike', 'auth_failure_spike']);
export type SecuritySignalKind = z.infer<typeof SecuritySignalKindSchema>;

export const SecuritySignalSchema = z
  .object({
    id: IdSchema,
    kind: SecuritySignalKindSchema,
    windowStart: z.iso.datetime(),
    eventCount: z.number().int().min(0),
    createdAt: z.iso.datetime(),
    acknowledgedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type SecuritySignal = z.infer<typeof SecuritySignalSchema>;

export const SecuritySignalListSchema = z
  .object({ signals: z.array(SecuritySignalSchema) })
  .strict();
export const SecuritySignalParamsSchema = z.object({ signalId: IdSchema }).strict();

/** Detection window and thresholds: events of one kind within the window raise one signal. */
export const SECURITY_WINDOW_MINUTES = 5;
export const ACCESS_DENIED_THRESHOLD = 20;
export const AUTH_FAILURE_THRESHOLD = 10;
