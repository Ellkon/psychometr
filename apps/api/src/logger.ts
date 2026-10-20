import type { FastifyRequest, FastifyServerOptions } from "fastify";

// Everything sensitive that may reach a log line. Extend this list whenever a
// new sensitive field appears (AGENTS.md, security rule 3).
export const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.password",
  "*.code",
  "*.token",
  "*.inviteToken",
  "*.refreshToken",
  "*.accessToken",
  "*.fullName",
  "*.phone",
  "*.birthDate",
  "*.snils",
  "*.answers",
  "*.score",
];

export function loggerOptions(level: string): NonNullable<FastifyServerOptions["logger"]> {
  return {
    level,
    redact: { paths: redactPaths, censor: "[REDACTED]" },
    serializers: {
      // Log only method and route pattern: raw URLs can carry invite tokens
      // (/i/<token>) and patient ids in query strings.
      req(request: FastifyRequest) {
        return { method: request.method, route: request.routeOptions.url ?? "unmatched" };
      },
    },
  };
}
