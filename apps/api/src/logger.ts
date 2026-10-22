/**
 * Logger configuration.
 *
 * Hard rule (AGENTS.md § Безопасность, NFR S-8): personal data, clinical data,
 * passwords, tokens and invite codes must never reach logs. New sensitive fields
 * MUST be added to `redactPaths` below when they appear.
 */
import { pino, type Logger, type LoggerOptions } from 'pino';

/** Paths censored in every log record. Extend when adding sensitive fields. */
export const redactPaths: string[] = [
  // Credentials and tokens
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'inviteToken',
  '*.inviteToken',
  'code',
  '*.code',
  'inviteCode',
  '*.inviteCode',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  // Personal data (patient_identity, 152-ФЗ)
  'firstName',
  '*.firstName',
  'lastName',
  '*.lastName',
  'middleName',
  '*.middleName',
  'phone',
  '*.phone',
  'birthDate',
  '*.birthDate',
  'snils',
  '*.snils',
  'email',
  '*.email',
  // Clinical data
  'answers',
  '*.answers',
  'score',
  '*.score',
  'totalScore',
  '*.totalScore',
  'medication',
  '*.medication',
  'diagnosis',
  '*.diagnosis',
];

export function buildLoggerOptions(level: LoggerOptions['level']): LoggerOptions {
  return {
    level,
    redact: { paths: redactPaths, censor: '[REDACTED]' },
    // Never log the payload of requests: it may contain clinical data.
    serializers: {
      req(req: { method: string; url: string; id: string }) {
        return { method: req.method, url: req.url, id: req.id };
      },
      res(res: { statusCode: number }) {
        return { statusCode: res.statusCode };
      },
    },
  };
}

export function createLogger(level: LoggerOptions['level']): Logger {
  return pino(buildLoggerOptions(level));
}
