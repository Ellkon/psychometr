#!/usr/bin/env node
// Generate local-only keys, never print their values or overwrite an existing file.
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const argumentsList = process.argv.slice(2);
const files = argumentsList.filter((value) => !value.startsWith('--'));
if (
  files.length > 1 ||
  argumentsList.some((value) => value.startsWith('--') && value !== '--test-consent')
)
  throw new Error('Usage: init-local-env.mjs [private-env-file] [--test-consent]');
const target = resolve(files[0] ?? '.env');
const test = argumentsList.includes('--test-consent');
const secret = () => randomBytes(32).toString('hex');
const databasePassword = secret(),
  appPassword = secret(),
  migratorPassword = secret();
const values = {
  NODE_ENV: 'development',
  HOST: '0.0.0.0',
  PORT: '3000',
  LOG_LEVEL: 'info',
  PUBLIC_ORIGIN: 'https://localhost:8443',
  APP_HOST: 'localhost',
  TRUST_PROXY: 'one-hop',
  POSTGRES_PASSWORD: databasePassword,
  POSTGRES_APP_PASSWORD: appPassword,
  POSTGRES_MIGRATOR_PASSWORD: migratorPassword,
  DATABASE_URL: `postgresql://app:${appPassword}@db:5432/psychometr`,
  MIGRATION_DATABASE_URL: `postgresql://migrator:${migratorPassword}@db:5432/psychometr`,
  APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  JWT_ACCESS_SECRET: randomBytes(32).toString('base64'),
  CONSENT_VERSION: test ? 'ci-synthetic-v1' : '',
  CONSENT_TEXT_PATH: test ? '/run/consent/approved.txt' : '',
  ADMIN_EMAIL: 'admin@example.test',
  ADMIN_PASSWORD: secret(),
};
await writeFile(
  target,
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n') + '\n',
  { flag: 'wx', mode: 0o600 },
);
if (test) {
  try {
    await mkdir(new URL('../infra/consent/', import.meta.url), { recursive: true });
    await writeFile(
      new URL('../infra/consent/approved.txt', import.meta.url),
      'СИНТЕТИЧЕСКИЙ ДОКУМЕНТ ДЛЯ АВТОМАТИЧЕСКИХ ТЕСТОВ. Не является согласием на обработку данных настоящих пациентов.\n',
      { flag: 'wx' },
    );
  } catch (error) {
    // We created this env file with wx, so it cannot be the operator's old file.
    await rm(target);
    throw error;
  }
}
console.log('Private local environment file created. Do not commit or share it.');
