import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  AdverseEventInputSchema,
  ApiErrorSchema,
  CreatedSchema,
  DoseMarkInputSchema,
  DrugCatalogSchema,
  EmptyBodySchema,
  MedicationInputSchema,
  MedicationParamsSchema,
  PageQuerySchema,
  PatientParamsSchema,
  PatientTherapySchema,
  RegistrySchema,
  SuccessSchema,
  TimelineSchema,
} from '@psychometr/shared';
import type { AuthService } from '../domain/auth.js';
import type { RegistryService } from '../domain/registry.js';
import type { TherapyService } from '../domain/therapy.js';
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

export function registerTherapyRoutes(
  app: FastifyInstance,
  auth: AuthService,
  therapy: TherapyService,
  registry: RegistryService,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const preHandler = protectRoute(auth);
  // ГРЛС snapshot: public registry data, no patient data; doctors only.
  api.get(
    '/api/drugs',
    { preHandler, schema: { response: { 200: DrugCatalogSchema, ...errors } } },
    (request) => therapy.catalog(principal(request)),
  );
  api.get(
    '/api/registry',
    {
      preHandler,
      schema: { querystring: PageQuerySchema, response: { 200: RegistrySchema, ...errors } },
    },
    (request) => registry.registry(principal(request), request.query.offset, request.query.limit),
  );
  api.get(
    '/api/patients/:patientId/timeline',
    {
      preHandler,
      schema: { params: PatientParamsSchema, response: { 200: TimelineSchema, ...errors } },
    },
    (request) => registry.timeline(principal(request), request.params.patientId),
  );
  api.get(
    '/api/patients/:patientId/therapy',
    {
      preHandler,
      schema: { params: PatientParamsSchema, response: { 200: PatientTherapySchema, ...errors } },
    },
    (request) => therapy.list(principal(request), request.params.patientId),
  );
  api.post(
    '/api/patients/:patientId/medications',
    {
      preHandler,
      schema: {
        params: PatientParamsSchema,
        body: MedicationInputSchema,
        response: { 201: CreatedSchema, ...errors },
      },
    },
    async (request, reply) => {
      const created = await therapy.prescribe(
        principal(request),
        request.params.patientId,
        request.body,
      );
      reply.code(201);
      return created;
    },
  );
  api.post(
    '/api/patients/:patientId/medications/:medicationId/stop',
    {
      preHandler,
      schema: {
        params: MedicationParamsSchema,
        body: EmptyBodySchema,
        response: { 200: SuccessSchema, ...errors },
      },
    },
    (request) =>
      therapy.stop(principal(request), request.params.patientId, request.params.medicationId),
  );
  api.post(
    '/api/patients/:patientId/medications/:medicationId/doses',
    {
      preHandler,
      schema: {
        params: MedicationParamsSchema,
        body: DoseMarkInputSchema,
        response: { 200: SuccessSchema, ...errors },
      },
    },
    (request) =>
      therapy.markDose(
        principal(request),
        request.params.patientId,
        request.params.medicationId,
        request.body,
      ),
  );
  api.post(
    '/api/patients/:patientId/adverse-events',
    {
      preHandler,
      schema: {
        params: PatientParamsSchema,
        body: AdverseEventInputSchema,
        response: { 201: CreatedSchema, ...errors },
      },
    },
    async (request, reply) => {
      const created = await therapy.reportAdverseEvent(
        principal(request),
        request.params.patientId,
        request.body,
      );
      reply.code(201);
      return created;
    },
  );
}
