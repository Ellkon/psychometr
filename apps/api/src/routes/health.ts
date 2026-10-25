import { ApiErrorSchema, HealthResponseSchema, SHARED_CONTRACT_VERSION } from '@psychometr/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

export function registerHealthRoutes(app: FastifyInstance, ready: () => Promise<void>): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const health = () => ({
    status: 'ok' as const,
    service: 'api',
    version: SHARED_CONTRACT_VERSION,
    timestamp: new Date().toISOString(),
  });
  typedApp.get('/api/health', { schema: { response: { 200: HealthResponseSchema } } }, health);
  typedApp.get(
    '/api/ready',
    { schema: { response: { 200: HealthResponseSchema, 503: ApiErrorSchema } } },
    async (_request, reply) => {
      try {
        await ready();
        return health();
      } catch {
        reply.code(503);
        return { error: { code: 'not_ready', message: 'Сервис временно недоступен' } };
      }
    },
  );
}
