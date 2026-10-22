/**
 * Application factory. Kept separate from index.ts so tests can build the app
 * and use `app.inject()` without opening a network port.
 */
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import Fastify, { type FastifyInstance } from 'fastify';

import { loadEnv, type Env } from './env.js';
import { registerErrorHandler } from './errors.js';
import { buildLoggerOptions } from './logger.js';
import { registerSecurity } from './plugins/security.js';
import { registerHealthRoutes } from './routes/health.js';

export interface BuildAppOptions {
  env?: Env;
  /** Disable request logging in tests. */
  silent?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? loadEnv();

  const app = Fastify({
    logger: options.silent
      ? false
      : buildLoggerOptions(env.LOG_LEVEL === 'silent' ? 'silent' : env.LOG_LEVEL),
    // Never accept more than 1 MiB bodies; clinical forms are far smaller.
    bodyLimit: 1_048_576,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await registerSecurity(app);
  registerErrorHandler(app);
  registerHealthRoutes(app);

  return app;
}
