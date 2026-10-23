import { pino, type Logger, type LoggerOptions } from 'pino';

// Never log request/response bodies. This is an additional safety net for
// structured application logs, not permission to log arbitrary payloads.
const sensitiveFields = [
  'password',
  'passwordHash',
  'credentialHash',
  'token',
  'tokenHash',
  'accessToken',
  'refreshToken',
  'inviteToken',
  'code',
  'inviteCode',
  'codeHash',
  'personalCode',
  'deviceSecret',
  'secretHash',
  'firstName',
  'lastName',
  'middleName',
  'phone',
  'birthDate',
  'snils',
  'email',
  'identity',
  'answers',
  'functionalAnswer',
  'score',
  'totalScore',
  'bandLabel',
  'safetySignal',
  'facts',
  'comment',
  'medication',
  'diagnosis',
  'ciphertext',
  'body',
  'payload',
  'APP_ENCRYPTION_KEY',
  'JWT_ACCESS_SECRET',
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
];
export const redactPaths: string[] = [
  ...sensitiveFields.flatMap((field) => [field, `*.${field}`, `*.*.${field}`]),
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];
export function buildLoggerOptions(level: LoggerOptions['level']): LoggerOptions {
  return {
    level,
    redact: { paths: redactPaths, censor: '[REDACTED]' },
    serializers: {
      // URLs may contain invite tokens, query secrets, or other personal data.
      // Only the declared route template is safe (not raw url/originalUrl).
      req(req: { method: string; id: string; routeOptions?: { url?: string } }) {
        return { method: req.method, id: req.id, route: req.routeOptions?.url ?? 'unmatched' };
      },
      res(res: { statusCode: number }) {
        return { statusCode: res.statusCode };
      },
      // SQL/parser error messages, stacks and causes may embed user input.
      err() {
        return { type: 'Error', detail: '[REDACTED]' };
      },
    },
  };
}
export function createLogger(level: LoggerOptions['level']): Logger {
  return pino(buildLoggerOptions(level));
}
