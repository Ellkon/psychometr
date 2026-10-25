import { readFile } from 'node:fs/promises';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyMetrics from 'fastify-metrics';
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
import { SecuritySignalService } from './domain/security-signals.js';
import { registerSecurityRoutes } from './routes/security.js';
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
        // `code` is redacted (invite codes), so the SQLSTATE goes under its own name.
        app.log.error({ sqlState: code }, 'database idle client error');
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
  const tokens = new AccessTokens(Buffer.from(env.JWT_ACCESS_SECRET, 'base64'), options.clock);
  await registerSecurity(app, async (token) => {
    try {
      return (await tokens.verify(token)).sub;
    } catch {
      return null;
    }
  });
  // Prometheus (NFR-3). /metrics sits outside /api, so Caddy never exposes it: only the internal
  // network can scrape it. Route labels are route patterns, never URLs with patient ids.
  // CommonJS package: under NodeNext the plugin is the `default` export of the namespace.
  await app.register(fastifyMetrics.default, {
    endpoint: '/metrics',
    clearRegisterOnInit: true,
    routeMetrics: { enabled: true, registeredRoutesOnly: true, groupStatusCodes: false },
  });
  registerErrorHandler(app);
  let consent = options.consent;
  if (!consent && env.CONSENT_TEXT_PATH && env.CONSENT_VERSION) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Deployment-only configuration, never request input.
    const text = await readFile(env.CONSENT_TEXT_PATH, 'utf8');
    consent = ConsentDocumentSchema.parse({ version: env.CONSENT_VERSION, text });
  }
  const vault = new IdentityVault(Buffer.from(env.APP_ENCRYPTION_KEY, 'base64'));
  const auth = await AuthService.create({ db, vault, tokens, consent, clock: options.clock });
  const alerts = new AlertService(db, vault, new AlertHub(), options.clock);
  // Exposed for tests and operations; the same instance serves sockets and the worker.
  app.decorate('alerts', alerts);
  const delivery = new app.metrics.client.Histogram({
    name: 'compass_alert_delivery_seconds',
    help: 'Time from alert creation to receipt confirmed by the doctor client (FR-8.2)',
    buckets: [0.5, 1, 2, 5, 10, 30, 60, 300, 1800],
  });
  const acknowledgement = new app.metrics.client.Histogram({
    name: 'compass_alert_acknowledgement_seconds',
    help: 'Time from alert creation to acknowledgement by the doctor (FR-8.2)',
    buckets: [10, 30, 60, 300, 900, 1800, 3600, 7200],
  });
  alerts.metrics = {
    delivered: (seconds) => {
      delivery.observe(seconds);
    },
    acknowledged: (seconds) => {
      acknowledgement.observe(seconds);
    },
  };
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
  const signals = new SecuritySignalService(db, options.clock);
  registerSecurityRoutes(app, auth, signals);
  if (options.workers ?? true) {
    let running = false;
    // Only the SQLSTATE or error name: driver messages can embed query parameters.
    const logFailure = (job: string) => (error: unknown) => {
      const code =
        (error as { code?: unknown }).code ?? (error instanceof Error ? error.name : undefined);
      app.log.error(
        { job, errorCode: typeof code === 'string' ? code : 'unknown' },
        'worker failed',
      );
    };
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      // Independent jobs: a failing alert pass must not stop anomaly detection, and back.
      void Promise.all([
        alerts.tick().catch(logFailure('alerts')),
        signals.check().catch(logFailure('security_signals')),
      ]).finally(() => {
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
