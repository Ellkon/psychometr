/**
 * Uniform error handling. Clients receive the ApiError envelope only —
 * stack traces and internal messages are logged, never returned.
 */
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import { ZodError } from 'zod';

function sendApiError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.status(statusCode).send({ error: { code, message } });
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | ZodError, request, reply) => {
    if (error instanceof ZodError) {
      return sendApiError(reply, 400, 'bad_request', 'Некорректные данные запроса');
    }

    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 400 && statusCode < 500) {
      // Client mistake: safe generic message, details only to the log.
      request.log.debug({ err: { message: error.message, code: error.code } }, 'client error');
      return sendApiError(reply, statusCode, error.code, 'Некорректный запрос');
    }

    // Server mistake: full details to the log, generic message to the client.
    request.log.error({ err: error }, 'unhandled server error');
    return sendApiError(reply, 500, 'internal_error', 'Внутренняя ошибка сервера');
  });

  app.setNotFoundHandler((request, reply) => {
    void sendApiError(reply, 404, 'not_found', 'Маршрут не найден');
  });
}
