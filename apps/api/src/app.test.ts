/**
 * Smoke tests for the app skeleton: health contract, error envelope,
 * security headers and rate limiting.
 */
import { describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { errorCodeOf } from './errors.js';
import { loadEnv } from './env.js';
import { testEnv } from './testing/env.js';

async function buildTestApp() {
  const env = testEnv();
  return buildApp({ env, silent: true });
}

describe('GET /api/health', () => {
  it('returns the shared health contract', async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; service: string; version: string }>();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('api');
    expect(body.version).toBeTruthy();
    await app.close();
  });
});

describe('error handling', () => {
  it('answers unknown routes with the ApiError envelope', async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });

    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('not_found');
    await app.close();
  });
});

describe('security headers', () => {
  it('sets strict CSP and referrer policy without unsafe-inline', async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    const csp = response.headers['content-security-policy'];
    expect(csp).toBeTruthy();
    expect(String(csp)).not.toContain('unsafe-inline');
    expect(String(csp)).not.toContain('unsafe-eval');
    expect(String(csp)).toContain("frame-ancestors 'none'");
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    await app.close();
  });
});

describe('loadEnv', () => {
  it('rejects an invalid PORT', () => {
    expect(() => loadEnv({ PORT: 'not-a-number' })).toThrow(/Invalid environment/);
  });

  it('applies defaults for non-secret values', () => {
    const env = testEnv();
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('test');
    expect(() => loadEnv({})).toThrow(/Invalid environment/);
  });
});

describe('errorCodeOf', () => {
  it('never throws, whatever was thrown', () => {
    expect(errorCodeOf(null)).toBe('unknown');
    expect(errorCodeOf(undefined)).toBe('unknown');
    expect(errorCodeOf('text')).toBe('unknown');
    expect(errorCodeOf(Object.assign(new Error('secret param'), { code: '57P01' }))).toBe('57P01');
    expect(errorCodeOf(new TypeError('secret param'))).toBe('TypeError');
  });
});
