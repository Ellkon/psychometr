import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  EmptyBodySchema,
  AuthorizationHeaderSchema,
  AcceptInviteSchema,
  ApiErrorSchema,
  AssignPractitionerSchema,
  AuditListSchema,
  AuditVerificationSchema,
  AuthResponseSchema,
  CareTeamParamsSchema,
  ConsentDocumentSchema,
  CreatePatientSchema,
  CreatePractitionerSchema,
  CreatedInviteSchema,
  CreatedPatientSchema,
  InviteListSchema,
  OpaqueTokenSchema,
  PageQuerySchema,
  PatientIdentitySchema,
  PatientListSchema,
  PatientLoginSchema,
  PatientParamsSchema,
  PatientRecordSchema,
  PractitionerListSchema,
  PrincipalSchema,
  StaffLoginSchema,
  SuccessSchema,
  type Principal,
} from '@psychometr/shared';
import { type AuthService, SESSION_MS, type LoginResult } from '../domain/auth.js';
import type { PatientService } from '../domain/patients.js';
import { AccessDenied, DomainError, unauthorized } from '../domain/errors.js';
import { digest } from '../security/credentials.js';

export const REFRESH_COOKIE = '__Host-compass-refresh';
export const DEVICE_COOKIE = '__Host-compass-device';
const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict' as const,
  path: '/',
  maxAge: SESSION_MS / 1000,
};
const errors = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
  429: ApiErrorSchema,
  503: ApiErrorSchema,
};

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}
export function principal(request: FastifyRequest): Principal {
  if (!request.principal) throw unauthorized();
  return request.principal;
}
function cookieValue(request: FastifyRequest, name: string): string | undefined {
  // Names are fixed constants supplied by this module, never user input.
  const result = OpaqueTokenSchema.safeParse(
    name === REFRESH_COOKIE
      ? request.cookies['__Host-compass-refresh']
      : request.cookies['__Host-compass-device'],
  );
  return result.success ? result.data : undefined;
}
function sendLogin(reply: FastifyReply, login: LoginResult) {
  reply.setCookie(REFRESH_COOKIE, login.refresh, cookieOptions);
  if (login.device) reply.setCookie(DEVICE_COOKIE, login.device, cookieOptions);
  return login.response;
}

/** Bearer authentication for every protected route; denials are counted by AuthService. */
export function protectRoute(auth: AuthService) {
  return async (request: FastifyRequest): Promise<void> => {
    const header = AuthorizationHeaderSchema.safeParse(request.headers);
    if (!header.success) {
      await auth.deny();
      throw unauthorized();
    }
    request.principal = await auth.authenticate(header.data.authorization.slice(7));
  };
}

export function registerAccessRoutes(
  app: FastifyInstance,
  auth: AuthService,
  patients: PatientService,
  origin: string,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  app.decorateRequest('principal', null);
  const protectedRoute = protectRoute(auth);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site')
    ) {
      await auth.deny();
      throw new AccessDenied();
    }
  });
  // createRateLimit composes with the IP gate; a second rateLimit hook does not.
  const inviteLimiter = app.createRateLimit({
    max: 5,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      const parsed = AcceptInviteSchema.safeParse(request.body);
      return parsed.success ? `invite:${digest(parsed.data.token)}` : `invite:${request.ip}`;
    },
  });
  const loginLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };
  api.post(
    '/api/auth/login',
    {
      config: loginLimit,
      bodyLimit: 8192,
      schema: { body: StaffLoginSchema, response: { 200: AuthResponseSchema, ...errors } },
    },
    async (request, reply) =>
      sendLogin(reply, await auth.staffLogin(request.body.email, request.body.password)),
  );
  api.get(
    '/api/auth/consent',
    { schema: { response: { 200: ConsentDocumentSchema, ...errors } } },
    () => auth.consent,
  );
  api.post(
    '/api/auth/invites/accept',
    {
      bodyLimit: 8192,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: async (request, reply) => {
        const limit = await inviteLimiter(request);
        if (!limit.isAllowed && limit.isExceeded) {
          reply.header('Retry-After', limit.ttlInSeconds);
          await auth.deny();
          throw new DomainError(429, 'rate_limited', 'Слишком много попыток. Повторите позже');
        }
      },
      schema: { body: AcceptInviteSchema, response: { 200: AuthResponseSchema, ...errors } },
    },
    async (request, reply) => sendLogin(reply, await auth.acceptInvite(request.body, request.ip)),
  );
  api.post(
    '/api/auth/patient/login',
    {
      bodyLimit: 8192,
      config: loginLimit,
      schema: { body: PatientLoginSchema, response: { 200: AuthResponseSchema, ...errors } },
    },
    async (request, reply) => {
      const binding = cookieValue(request, DEVICE_COOKIE);
      if (!binding) {
        await auth.deny();
        throw unauthorized();
      }
      return sendLogin(reply, await auth.patientLogin(binding, request.body.personalCode));
    },
  );
  api.post(
    '/api/auth/refresh',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { body: EmptyBodySchema, response: { 200: AuthResponseSchema, ...errors } },
    },
    async (request, reply) => {
      const refresh = cookieValue(request, REFRESH_COOKIE);
      if (!refresh) {
        await auth.deny();
        throw unauthorized();
      }
      try {
        return sendLogin(reply, await auth.refresh(refresh));
      } catch (error) {
        reply.clearCookie(REFRESH_COOKIE, cookieOptions);
        throw error;
      }
    },
  );
  api.post(
    '/api/auth/logout',
    { schema: { body: EmptyBodySchema, response: { 200: SuccessSchema, ...errors } } },
    async (request, reply) => {
      await auth.logout(cookieValue(request, REFRESH_COOKIE));
      // Open alert sockets of the ended session close at the next worker tick (S-2).
      app.alerts.requestSweep();
      reply.clearCookie(REFRESH_COOKIE, cookieOptions);
      // The binding alone cannot authenticate; it still requires the personal code.
      return { ok: true as const };
    },
  );
  api.get(
    '/api/auth/me',
    { preHandler: protectedRoute, schema: { response: { 200: PrincipalSchema, ...errors } } },
    (request) => principal(request),
  );
  api.post(
    '/api/patients',
    {
      preHandler: protectedRoute,
      schema: { body: CreatePatientSchema, response: { 201: CreatedPatientSchema, ...errors } },
    },
    async (request, reply) => {
      const patient = await patients.create(principal(request), request.body.identity);
      reply.code(201);
      return patient;
    },
  );
  api.get(
    '/api/patients',
    {
      preHandler: protectedRoute,
      schema: { querystring: PageQuerySchema, response: { 200: PatientListSchema, ...errors } },
    },
    (request) => patients.list(principal(request), request.query.offset, request.query.limit),
  );
  api.get(
    '/api/patients/:patientId',
    {
      preHandler: protectedRoute,
      schema: { params: PatientParamsSchema, response: { 200: PatientRecordSchema, ...errors } },
    },
    (request) => patients.read(principal(request), request.params.patientId),
  );
  api.patch(
    '/api/patients/:patientId/identity',
    {
      preHandler: protectedRoute,
      schema: {
        params: PatientParamsSchema,
        body: PatientIdentitySchema,
        response: { 200: SuccessSchema, ...errors },
      },
    },
    (request) =>
      patients.updateIdentity(principal(request), request.params.patientId, request.body),
  );
  api.post(
    '/api/patients/:patientId/invites',
    {
      preHandler: protectedRoute,
      schema: {
        params: PatientParamsSchema,
        body: EmptyBodySchema,
        response: { 201: CreatedInviteSchema, ...errors },
      },
    },
    async (request, reply) => {
      const invite = await patients.createInvite(principal(request), request.params.patientId);
      reply.code(201);
      return invite;
    },
  );
  api.get(
    '/api/patients/:patientId/invites',
    {
      preHandler: protectedRoute,
      schema: { params: PatientParamsSchema, response: { 200: InviteListSchema, ...errors } },
    },
    (request) => patients.invites(principal(request), request.params.patientId),
  );
  api.post(
    '/api/patients/:patientId/sessions/revoke',
    {
      preHandler: protectedRoute,
      schema: {
        params: PatientParamsSchema,
        body: EmptyBodySchema,
        response: { 200: SuccessSchema, ...errors },
      },
    },
    (request) => patients.revokeSessions(principal(request), request.params.patientId),
  );
  api.post(
    '/api/admin/practitioners',
    {
      preHandler: protectedRoute,
      schema: {
        body: CreatePractitionerSchema,
        response: { 201: CreatedPatientSchema, ...errors },
      },
    },
    async (request, reply) => {
      const doctor = await patients.createPractitioner(
        principal(request),
        request.body.email,
        request.body.password,
      );
      reply.code(201);
      return doctor;
    },
  );
  api.get(
    '/api/admin/practitioners',
    {
      preHandler: protectedRoute,
      schema: { response: { 200: PractitionerListSchema, ...errors } },
    },
    (request) => patients.listPractitioners(principal(request)),
  );
  api.post(
    '/api/admin/care-team/:patientId',
    {
      preHandler: protectedRoute,
      schema: {
        params: PatientParamsSchema,
        body: AssignPractitionerSchema,
        response: { 200: SuccessSchema, ...errors },
      },
    },
    (request) =>
      patients.changeCareTeam(
        principal(request),
        request.params.patientId,
        request.body.practitionerId,
        false,
      ),
  );
  api.delete(
    '/api/admin/care-team/:patientId/:practitionerId',
    {
      preHandler: protectedRoute,
      schema: {
        params: CareTeamParamsSchema,
        body: EmptyBodySchema,
        response: { 200: SuccessSchema, ...errors },
      },
    },
    (request) =>
      patients.changeCareTeam(
        principal(request),
        request.params.patientId,
        request.params.practitionerId,
        true,
      ),
  );
  api.get(
    '/api/admin/audit',
    {
      preHandler: protectedRoute,
      schema: { querystring: PageQuerySchema, response: { 200: AuditListSchema, ...errors } },
    },
    (request) => patients.audit(principal(request), request.query.offset, request.query.limit),
  );
  api.get(
    '/api/admin/audit/verify',
    {
      preHandler: protectedRoute,
      schema: { response: { 200: AuditVerificationSchema, ...errors } },
    },
    (request) => patients.verifyAudit(principal(request)),
  );
}
