import { describe, expect, it } from 'vitest';

import { DiagnosisInputSchema, Icd10FileSchema, parseDiagnosisEntry } from './index.js';

describe('parseDiagnosisEntry', () => {
  it('splits a catalog suggestion into code and text', () => {
    expect(parseDiagnosisEntry('F32.1 Депрессивный эпизод средней степени')).toEqual({
      code: 'F32.1',
      text: 'Депрессивный эпизод средней степени',
    });
  });

  it('accepts a lower-case code alone', () => {
    expect(parseDiagnosisEntry('  f41.1 ')).toEqual({ code: 'F41.1', text: 'F41.1' });
  });

  it('keeps free text without a code', () => {
    expect(parseDiagnosisEntry('Тревожно-депрессивный синдром')).toEqual({
      code: null,
      text: 'Тревожно-депрессивный синдром',
    });
    expect(parseDiagnosisEntry('F32.1Депрессия').code).toBeNull();
  });
});

describe('DiagnosisInputSchema', () => {
  const base = { submissionId: '00000000-0000-4000-8000-000000000001', text: 'Диагноз' };

  it('rejects a malformed code and empty text', () => {
    expect(DiagnosisInputSchema.safeParse({ ...base, code: 'F32.123' }).success).toBe(false);
    expect(DiagnosisInputSchema.safeParse({ ...base, code: 'f32' }).success).toBe(false);
    expect(DiagnosisInputSchema.safeParse({ ...base, code: null, text: '  ' }).success).toBe(false);
    expect(DiagnosisInputSchema.safeParse({ ...base, code: 'F32' }).success).toBe(true);
  });
});

describe('Icd10FileSchema', () => {
  it('rejects duplicate codes', () => {
    const file = { id: 'mkb10', source_id: 'mkb10', version: '2.27', selection: 'z' };
    const entry = { code: 'F32', name: 'Депрессивный эпизод' };
    expect(Icd10FileSchema.safeParse({ ...file, entries: [entry] }).success).toBe(true);
    expect(Icd10FileSchema.safeParse({ ...file, entries: [entry, entry] }).success).toBe(false);
  });
});
