/**
 * Security baseline: helmet (strict CSP, no-referrer), rate limiting.
 * Hard rules (AGENTS.md): never weaken CSP, never add unsafe-inline/unsafe-eval,
 * never disable helmet. If a task seems to require it — stop and ask.
 */
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

/** Requests per minute per IP. Tuned per-endpoint later (invites, auth). */
const GLOBAL_RATE_LIMIT_MAX = 300;

export async function registerSecurity(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: { maxAge: 15_552_000, includeSubDomains: true, preload: false },
  });

  await app.register(rateLimit, {
    global: true,
    max: GLOBAL_RATE_LIMIT_MAX,
    timeWindow: '1 minute',
  });
}
