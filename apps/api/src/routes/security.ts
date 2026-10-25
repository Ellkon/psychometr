import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ApiErrorSchema,
  EmptyBodySchema,
  SecuritySignalListSchema,
  SecuritySignalParamsSchema,
  SuccessSchema,
} from '@psychometr/shared';
import type { AuthService } from '../domain/auth.js';
import type { SecuritySignalService } from '../domain/security-signals.js';
import { principal, protectRoute } from './access.js';

const errors = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  429: ApiErrorSchema,
  503: ApiErrorSchema,
};

export function registerSecurityRoutes(
  app: FastifyInstance,
  auth: AuthService,
  signals: SecuritySignalService,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const preHandler = protectRoute(auth);
  api.get(
    '/api/admin/security-signals',
    { preHandler, schema: { response: { 200: SecuritySignalListSchema, ...errors } } },
    (request) => signals.list(principal(request)),
  );
  api.post(
    '/api/admin/security-signals/:signalId/ack',
    {
      preHandler,
      schema: {
        params: SecuritySignalParamsSchema,
        body: EmptyBodySchema,
        response: { 200: SuccessSchema, ...errors },
      },
    },
    (request) => signals.acknowledge(principal(request), request.params.signalId),
  );
}
