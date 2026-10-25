import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ApiErrorSchema,
  ContactInputSchema,
  ContactRequestCreatedSchema,
  ContactRequestInputSchema,
  CreatedSchema,
  PatientContactsSchema,
  PatientParamsSchema,
} from '@psychometr/shared';
import type { AuthService } from '../domain/auth.js';
import type { ContactService } from '../domain/contacts.js';
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

/** Contact between visits (FR-12). */
export function registerContactRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: ContactService,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const preHandler = protectRoute(auth);
  api.get(
    '/api/patients/:patientId/contacts',
    {
      preHandler,
      schema: { params: PatientParamsSchema, response: { 200: PatientContactsSchema, ...errors } },
    },
    (request) => service.list(principal(request), request.params.patientId),
  );
  api.post(
    '/api/patients/:patientId/contact-requests',
    {
      preHandler,
      schema: {
        params: PatientParamsSchema,
        body: ContactRequestInputSchema,
        response: { 200: ContactRequestCreatedSchema, 201: ContactRequestCreatedSchema, ...errors },
      },
    },
    async (request, reply) => {
      const result = await service.request(
        principal(request),
        request.params.patientId,
        request.body,
      );
      reply.code(result.existing ? 200 : 201);
      return result;
    },
  );
  api.post(
    '/api/patients/:patientId/contacts',
    {
      preHandler,
      schema: {
        params: PatientParamsSchema,
        body: ContactInputSchema,
        response: { 201: CreatedSchema, ...errors },
      },
    },
    async (request, reply) => {
      const created = await service.record(
        principal(request),
        request.params.patientId,
        request.body,
      );
      reply.code(201);
      return created;
    },
  );
}
