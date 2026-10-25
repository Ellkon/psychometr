/**
 * Common API contracts shared by apps/api and apps/web.
 * Schemas are the single source of truth; consumers must not duplicate them.
 */
import { z } from 'zod';

/** Semantic version of the shared contract package. */
export const SHARED_CONTRACT_VERSION = '0.1.0' as const;

/** Liveness probe response for GET /api/health. */
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  /** ISO-8601 timestamp of the response. */
  timestamp: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** Uniform error envelope for all API errors. Never contains internals. */
export const ApiErrorSchema = z.object({
  error: z.object({
    /** Stable machine-readable code, e.g. 'bad_request'. */
    code: z.string(),
    /** Human-readable message in Russian, safe to show to the user. */
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
