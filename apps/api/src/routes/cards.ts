import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ApiErrorSchema,
  PatientCardsSchema,
  PatientParamsSchema,
  SuccessSchema,
  TaskDecisionInputSchema,
  TaskParamsSchema,
} from '@psychometr/shared';
import type { AuthService } from '../domain/auth.js';
import type { ClinicalCardService } from '../domain/cards.js';
import { principal, protectRoute } from './access.js';

const errors = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
  429: ApiErrorSchema,
  503: ApiErrorSchema,
};

export function registerCardRoutes(
  app: FastifyInstance,
  auth: AuthService,
  cards: ClinicalCardService,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const preHandler = protectRoute(auth);
  api.get(
    '/api/patients/:patientId/cards',
    {
      preHandler,
      schema: { params: PatientParamsSchema, response: { 200: PatientCardsSchema, ...errors } },
    },
    (request) => cards.list(principal(request), request.params.patientId),
  );
  api.post(
    '/api/patients/:patientId/tasks/:taskId/decision',
    {
      preHandler,
      schema: {
        params: TaskParamsSchema,
        body: TaskDecisionInputSchema,
        response: { 200: SuccessSchema, ...errors },
      },
    },
    (request) =>
      cards.decide(
        principal(request),
        request.params.patientId,
        request.params.taskId,
        request.body,
      ),
  );
}
