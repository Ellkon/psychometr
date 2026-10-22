/**
 * Process entrypoint: build the app and listen. Handles graceful shutdown so
 * in-flight requests finish before the process exits.
 */
import { buildApp } from './app.js';
import { loadEnv } from './env.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp({ env });

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (error) {
    app.log.error({ err: error }, 'failed to start server');
    process.exit(1);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      void app.close().then(() => process.exit(0));
    });
  }
}

void main();
