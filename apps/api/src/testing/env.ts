import { randomBytes } from 'node:crypto';
import { loadEnv } from '../env.js';

/** Scrape token of test apps: tests read /metrics with it. */
export const TEST_METRICS_TOKEN = randomBytes(32).toString('base64url');

export function testEnv(databaseUrl = 'postgresql://unused@localhost/unused') {
  return loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: databaseUrl,
    APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    JWT_ACCESS_SECRET: randomBytes(32).toString('base64'),
    PUBLIC_ORIGIN: 'https://compass.test',
    METRICS_TOKEN: TEST_METRICS_TOKEN,
  });
}
