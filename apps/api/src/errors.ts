import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { DomainError } from './domain/errors.js';

/**
 * A loggable identifier of an error: the SQLSTATE or driver code, else the error class name.
 * Never the message, which can embed query parameters. Safe for any thrown value.
 */
export function errorCodeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
    return error.code;
  return error instanceof Error ? error.name : 'unknown';
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof DomainError)
      return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    const status =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    if (error instanceof ZodError || (status >= 400 && status < 500)) {
      return reply.code(error instanceof ZodError ? 400 : status).send({
        error: {
          code: status === 429 ? 'rate_limited' : 'bad_request',
          message:
            status === 429 ? 'Слишком много запросов. Повторите позже' : 'Некорректный запрос',
        },
      });
    }
    // Error messages/stacks may embed SQL parameters, decrypted identity or tokens.
    request.log.error({ errorCode: 'internal_error' }, 'Request failed');
    return reply
      .code(500)
      .send({ error: { code: 'internal_error', message: 'Внутренняя ошибка сервера' } });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'Маршрут не найден' } }),
  );
}
