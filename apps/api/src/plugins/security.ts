/**
 * Security baseline: helmet (strict CSP, no-referrer), rate limiting.
 * Hard rules (AGENTS.md): never weaken CSP, never add unsafe-inline/unsafe-eval,
 * never disable helmet. If a task seems to require it — stop and ask.
 */
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** Requests per minute per signed-in user, or per IP without a valid token. */
const GLOBAL_RATE_LIMIT_MAX = 300;

/** Returns the user id of a valid access token, or null. Must verify the signature. */
export type TokenSubject = (token: string) => Promise<string | null>;

/**
 * A clinic behind NAT shares one IP: counting per IP alone would throttle every doctor and
 * patient together. A verified token is counted per user; anything else per IP. A forged or
 * expired token falls back to the IP, so it cannot open a fresh bucket.
 */
function rateLimitKey(subject: TokenSubject) {
  return async (request: FastifyRequest): Promise<string> => {
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const user = await subject(header.slice('Bearer '.length));
      if (user) return `user:${user}`;
    }
    return `ip:${request.ip}`;
  };
}

export async function registerSecurity(app: FastifyInstance, subject: TokenSubject): Promise<void> {
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
    keyGenerator: rateLimitKey(subject),
  });
}
