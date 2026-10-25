import { readFile } from 'node:fs/promises';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import Fastify, { type FastifyInstance } from 'fastify';
import { ConsentDocumentSchema, type ConsentDocument } from '@psychometr/shared';
import { sql } from 'drizzle-orm';

import { loadEnv, type Env } from './env.js';
import { registerErrorHandler } from './errors.js';
import { buildLoggerOptions } from './logger.js';
import { registerSecurity } from './plugins/security.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAccessRoutes } from './routes/access.js';
import { connectDatabase, type Database } from './db/client.js';
import { AuthService } from './domain/auth.js';
import { PatientService } from './domain/patients.js';
import {
  ScaleService,
  findContentDir,
  loadScaleCatalog,
  type ScaleCatalog,
} from './domain/scales.js';
import { ClinicalCardService } from './domain/cards.js';
import { loadRuleEngine, type RuleEngine } from './domain/rules.js';
import { registerCardRoutes } from './routes/cards.js';
import { registerScaleRoutes } from './routes/scales.js';
import { registerTherapyRoutes } from './routes/therapy.js';
import { loadDrugRegistry } from './domain/drugs.js';
import { RegistryService } from './domain/registry.js';
import { TherapyService } from './domain/therapy.js';
import { AlertHub, AlertService } from './domain/alerts.js';
import { registerAlertRoutes } from './routes/alerts.js';
import { AccessTokens } from './security/access-token.js';
import { IdentityVault } from './security/identity.js';

export interface BuildAppOptions {
  env?: Env;
  silent?: boolean;
  db?: Database;
  consent?: ConsentDocument;
  clock?: () => Date;
  scales?: ScaleCatalog;
  rules?: RuleEngine;
  /** Background alert worker (outbox delivery and escalation). Tests drive `tick()` themselves. */
  workers?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    alerts: AlertService;
  }
}

const ALERT_TICK_MS = 1_000;
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? loadEnv();
  const app = Fastify({
    logger: options.silent ? false : buildLoggerOptions(env.LOG_LEVEL),
    bodyLimit: 65_536,
    trustProxy:
      env.TRUST_PROXY === 'one-hop' ? (_address: string, hop: number) => hop === 0 : false,
  });
  const connection = options.db
    ? undefined
    : connectDatabase(env.DATABASE_URL, (code) => {
        app.log.error({ code }, 'database idle client error');
      });
  const db = options.db ?? connection?.db;
  if (!db) throw new Error('Database not configured');
  if (connection)
    app.addHook('onClose', async () => {
      await connection.pool.end();
    });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 8_192 } });
  await registerSecurity(app);
  registerErrorHandler(app);
  let consent = options.consent;
  if (!consent && env.CONSENT_TEXT_PATH && env.CONSENT_VERSION) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Deployment-only configuration, never request input.
    const text = await readFile(env.CONSENT_TEXT_PATH, 'utf8');
    consent = ConsentDocumentSchema.parse({ version: env.CONSENT_VERSION, text });
  }
  const vault = new IdentityVault(Buffer.from(env.APP_ENCRYPTION_KEY, 'base64'));
  const tokens = new AccessTokens(Buffer.from(env.JWT_ACCESS_SECRET, 'base64'), options.clock);
  const auth = await AuthService.create({ db, vault, tokens, consent, clock: options.clock });
  const alerts = new AlertService(db, vault, new AlertHub(), options.clock);
  // Exposed for tests and operations; the same instance serves sockets and the worker.
  app.decorate('alerts', alerts);
  registerAccessRoutes(
    app,
    auth,
    new PatientService(db, vault, env.PUBLIC_ORIGIN, options.clock),
    env.PUBLIC_ORIGIN,
  );
  const scaleCatalog = options.scales ?? (await loadScaleCatalog());
  const ruleEngine = options.rules ?? (await loadRuleEngine(findContentDir()));
  const cards = new ClinicalCardService(db, ruleEngine, options.clock, alerts);
  registerScaleRoutes(app, auth, new ScaleService(db, scaleCatalog, options.clock, cards));
  registerCardRoutes(app, auth, cards);
  registerTherapyRoutes(
    app,
    auth,
    new TherapyService(db, await loadDrugRegistry(findContentDir()), options.clock),
    new RegistryService(db, options.clock),
  );
  registerAlertRoutes(app, auth, alerts, env.PUBLIC_ORIGIN);
  if (options.workers ?? true) {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      alerts
        .tick()
        .catch((error: unknown) => {
          // Only the SQLSTATE or error name: driver messages can embed query parameters.
          const code =
            (error as { code?: unknown }).code ?? (error instanceof Error ? error.name : undefined);
          app.log.error(
            { errorCode: typeof code === 'string' ? code : 'unknown' },
            'alert worker tick failed',
          );
        })
        .finally(() => {
          running = false;
        });
    }, ALERT_TICK_MS);
    timer.unref();
    app.addHook('onClose', (_instance, done) => {
      clearInterval(timer);
      done();
    });
  }
  registerHealthRoutes(app, async () => {
    await db.execute(sql`select 1 from users limit 1`);
  });
  return app;
}
