/**
 * GET /api/health — liveness probe used by docker healthchecks, CI and ZAP.
 */
import { HealthResponseSchema, SHARED_CONTRACT_VERSION } from '@psychometr/shared';
import type { FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';

export function registerHealthRoutes(app: FastifyInstance): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.route({
    method: 'GET',
    url: '/api/health',
    schema: {
      response: {
        200: HealthResponseSchema,
      },
    },
    handler: () => ({
      status: 'ok' as const,
      service: 'api',
      version: SHARED_CONTRACT_VERSION,
      timestamp: new Date().toISOString(),
    }),
  });
}
