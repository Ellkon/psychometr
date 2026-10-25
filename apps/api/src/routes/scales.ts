import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ApiErrorSchema,
  PatientParamsSchema,
  PatientScalesSchema,
  ScaleCatalogSchema,
  ScaleParamsSchema,
  ScaleResultSchema,
  ScaleScheduleInputSchema,
  ScaleSubmissionSchema,
  SuccessSchema,
} from '@psychometr/shared';
import type { AuthService } from '../domain/auth.js';
import type { ScaleService } from '../domain/scales.js';
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

export function registerScaleRoutes(
  app: FastifyInstance,
  auth: AuthService,
  scales: ScaleService,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const preHandler = protectRoute(auth);
  // Catalog holds only published questionnaire text; no patient data.
  api.get(
    '/api/scales',
    { preHandler, schema: { response: { 200: ScaleCatalogSchema, ...errors } } },
    (request) => {
      principal(request);
      return { scales: scales.definitions() };
    },
  );
  api.get(
    '/api/patients/:patientId/scales',
    {
      preHandler,
      schema: { params: PatientParamsSchema, response: { 200: PatientScalesSchema, ...errors } },
    },
    (request) => scales.list(principal(request), request.params.patientId),
  );
  api.post(
    '/api/patients/:patientId/scales/:scaleId/responses',
    {
      preHandler,
      schema: {
        params: ScaleParamsSchema,
        body: ScaleSubmissionSchema,
        response: { 201: ScaleResultSchema, ...errors },
      },
    },
    async (request, reply) => {
      const result = await scales.submit(
        principal(request),
        request.params.patientId,
        request.params.scaleId,
        request.body,
      );
      reply.code(201);
      return result;
    },
  );
  api.put(
    '/api/patients/:patientId/scales/:scaleId/schedule',
    {
      preHandler,
      schema: {
        params: ScaleParamsSchema,
        body: ScaleScheduleInputSchema,
        response: { 200: SuccessSchema, ...errors },
      },
    },
    (request) =>
      scales.setSchedule(
        principal(request),
        request.params.patientId,
        request.params.scaleId,
        request.body,
      ),
  );
}
