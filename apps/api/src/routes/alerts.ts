import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { RawData, WebSocket } from 'ws';
import {
  AlertListSchema,
  AlertParamsSchema,
  AlertSocketClientMessageSchema,
  ApiErrorSchema,
  SuccessSchema,
  type Principal,
} from '@psychometr/shared';
import type { AuthService } from '../domain/auth.js';
import type { AlertService } from '../domain/alerts.js';
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

/** Close codes in the 4000 range are application-defined (RFC 6455). */
const CLOSE_NOT_AUTHENTICATED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_TOO_MANY = 4429;
const AUTH_TIMEOUT_MS = 5_000;
/** Matches the access-token lifetime (expiresIn 900 s): a socket cannot outlive its token. */
const SOCKET_MAX_MS = 15 * 60_000;
/** A client sends one auth and one receipt per alert; far more than this is abuse. */
const MAX_MESSAGES_PER_MINUTE = 120;

function text(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

export function registerAlertRoutes(
  app: FastifyInstance,
  auth: AuthService,
  alerts: AlertService,
  origin: string,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const preHandler = protectRoute(auth);

  api.get(
    '/api/alerts',
    { preHandler, schema: { response: { 200: AlertListSchema, ...errors } } },
    (request) => alerts.list(principal(request)),
  );
  api.post(
    '/api/alerts/:alertId/ack',
    {
      preHandler,
      schema: {
        params: AlertParamsSchema,
        response: { 200: SuccessSchema, ...errors },
      },
    },
    (request) => alerts.ack(principal(request), request.params.alertId),
  );

  // Browsers cannot send Authorization on a WebSocket, so the token is the first client message.
  // The origin check mirrors the REST mutation guard (routes/access.ts), so another site cannot
  // open a socket with a stolen token (cross-site WebSocket hijacking).
  app.get(
    '/ws',
    {
      websocket: true,
      onRequest: async (request, reply) => {
        if (request.headers.origin !== origin) {
          await reply.code(403).send({ error: 'forbidden', message: 'Недопустимый источник' });
        }
      },
    },
    (socket: WebSocket) => {
      let user: Principal | null = null;
      let authenticating = false;
      let closed = false;
      let windowStart = Date.now();
      let messages = 0;
      const deadline = setTimeout(() => {
        socket.close(CLOSE_NOT_AUTHENTICATED, 'auth_timeout');
      }, AUTH_TIMEOUT_MS);
      const lifetime = setTimeout(() => {
        socket.close(CLOSE_NOT_AUTHENTICATED, 'token_expired');
      }, SOCKET_MAX_MS);

      const handle = async (raw: RawData): Promise<void> => {
        const now = Date.now();
        if (now - windowStart >= 60_000) {
          windowStart = now;
          messages = 0;
        }
        messages += 1;
        if (messages > MAX_MESSAGES_PER_MINUTE) {
          socket.close(CLOSE_TOO_MANY, 'rate_limited');
          return;
        }
        const parsed = AlertSocketClientMessageSchema.safeParse(
          (() => {
            try {
              return JSON.parse(text(raw)) as unknown;
            } catch {
              return null;
            }
          })(),
        );
        if (!parsed.success) {
          socket.close(1008, 'bad_message');
          return;
        }
        const message = parsed.data;
        if (!user) {
          // One auth in flight: a second frame while the first is checked is a protocol error.
          if (message.type !== 'auth' || authenticating) {
            socket.close(CLOSE_NOT_AUTHENTICATED, 'not_authenticated');
            return;
          }
          authenticating = true;
          // Read-only check: authenticating a socket must not extend the session's idle timeout.
          const verified = await auth.socketPrincipal(message.token);
          // The client may have gone away during the check; never register a closed socket.
          if (closed) return;
          if (!verified) {
            socket.close(CLOSE_NOT_AUTHENTICATED, 'not_authenticated');
            return;
          }
          clearTimeout(deadline);
          if (verified.role !== 'doctor') {
            socket.close(CLOSE_FORBIDDEN, 'forbidden');
            return;
          }
          // Re-checked periodically by AlertService.sweepSockets: revocation closes the socket.
          const token = message.token;
          const live = async () => (await auth.socketPrincipal(token))?.id === verified.id;
          if (!alerts.hub.register(verified.id, socket, live)) {
            socket.close(CLOSE_TOO_MANY, 'too_many_sockets');
            return;
          }
          user = verified;
          socket.send(JSON.stringify({ type: 'ready' }));
          await alerts.flushFor(verified.id, socket);
          return;
        }
        if (message.type === 'received') await alerts.markReceived(user.id, message.alertId);
      };

      socket.on('message', (raw: RawData) => {
        handle(raw).catch((error: unknown) => {
          // Only the SQLSTATE or error name: driver messages can embed query parameters.
          const code =
            (error as { code?: unknown }).code ?? (error instanceof Error ? error.name : undefined);
          app.log.error(
            { errorCode: typeof code === 'string' ? code : 'unknown' },
            'alert socket message failed',
          );
          socket.close(1011, 'internal');
        });
      });
      socket.on('error', () => {
        // The close handler below cleans up; an unhandled 'error' would crash the process.
      });
      socket.on('close', () => {
        closed = true;
        clearTimeout(deadline);
        clearTimeout(lifetime);
        if (user) alerts.hub.unregister(user.id, socket);
      });
    },
  );
}
