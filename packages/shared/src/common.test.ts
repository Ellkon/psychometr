import { describe, expect, it } from 'vitest';

import { HealthResponseSchema, SourcesFileSchema } from './index.js';

describe('HealthResponseSchema', () => {
  it('accepts a well-formed health response', () => {
    const parsed = HealthResponseSchema.parse({
      status: 'ok',
      service: 'api',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    });
    expect(parsed.status).toBe('ok');
  });

  it('rejects an unknown status', () => {
    expect(() =>
      HealthResponseSchema.parse({
        status: 'degraded',
        service: 'api',
        version: '0.1.0',
        timestamp: new Date().toISOString(),
      }),
    ).toThrow();
  });
});

describe('SourcesFileSchema', () => {
  it('accepts an empty registry', () => {
    expect(SourcesFileSchema.parse({ sources: [] })).toEqual({ sources: [] });
  });

  it('rejects a source without required citation fields', () => {
    expect(() =>
      SourcesFileSchema.parse({
        sources: [{ id: 'kr-1', kind: 'clinical_guideline', title: 'КР X' }],
      }),
    ).toThrow();
  });
});
