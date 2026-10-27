import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ApiErrorSchema,
  CreatedSchema,
  DiagnosisInputSchema,
  DiagnosisParamsSchema,
  EmptyBodySchema,
  Icd10SearchQuerySchema,
  Icd10SearchResultSchema,
  PatientDiagnosesSchema,
  PatientParamsSchema,
  SuccessSchema,
} from '@psychometr/shared';
import type { AuthService } from '../domain/auth.js';
import type { DiagnosisService } from '../domain/diagnoses.js';
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

/** Diagnoses in the patient's card (FR-7.4). */
export function registerDiagnosisRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: DiagnosisService,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const preHandler = protectRoute(auth);
  // ICD-10 search: reference data, no patient data; doctors only.
  api.get(
    '/api/icd10',
    {
      preHandler,
      schema: {
        querystring: Icd10SearchQuerySchema,
        response: { 200: Icd10SearchResultSchema, ...errors },
      },
    },
    (request) => service.searchIcd10(principal(request), request.query.q),
  );
  api.get(
    '/api/patients/:patientId/diagnoses',
    {
      preHandler,
      schema: { params: PatientParamsSchema, response: { 200: PatientDiagnosesSchema, ...errors } },
    },
    (request) => service.list(principal(request), request.params.patientId),
  );
  api.post(
    '/api/patients/:patientId/diagnoses',
    {
      preHandler,
      schema: {
        params: PatientParamsSchema,
        body: DiagnosisInputSchema,
        response: { 201: CreatedSchema, ...errors },
      },
    },
    async (request, reply) => {
      const created = await service.add(principal(request), request.params.patientId, request.body);
      reply.code(201);
      return created;
    },
  );
  api.post(
    '/api/patients/:patientId/diagnoses/:diagnosisId/remove',
    {
      preHandler,
      schema: {
        params: DiagnosisParamsSchema,
        body: EmptyBodySchema,
        response: { 200: SuccessSchema, ...errors },
      },
    },
    (request) =>
      service.remove(principal(request), request.params.patientId, request.params.diagnosisId),
  );
}
