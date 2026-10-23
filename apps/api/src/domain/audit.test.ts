import { describe, expect, it } from 'vitest';
import { auditHash, verifyAuditChain, GENESIS_HASH } from './audit.js';
import { digest } from '../security/credentials.js';

const at = new Date('2026-10-23T10:00:00.000Z');
const base = {
  sequence: 1,
  occurredAt: at,
  actorId: null,
  resourceId: null,
  action: 'auth.login',
  previousHash: GENESIS_HASH,
} as const;

describe('audit hash compatibility', () => {
  it('hashes rows without detail exactly as before the detail column existed', () => {
    const legacy = digest(
      JSON.stringify([1, 1, at.toISOString(), null, null, 'auth.login', GENESIS_HASH]),
    );
    expect(auditHash({ ...base, detail: null })).toBe(legacy);
    expect(auditHash(base)).toBe(legacy);
  });

  it('covers the detail when present', () => {
    const plain = auditHash({ ...base, detail: null });
    const withScale = auditHash({ ...base, detail: 'phq9' });
    expect(withScale).not.toBe(plain);
  });

  it('verifies a mixed chain of legacy and detailed rows', () => {
    const first = { ...base, hash: auditHash({ ...base, detail: null }) };
    const secondBase = {
      ...base,
      sequence: 2,
      action: 'scale.answered' as const,
      previousHash: first.hash,
      detail: 'gad7',
    };
    const second = { ...secondBase, hash: auditHash(secondBase) };
    expect(verifyAuditChain([first, second])).toBe(true);
    expect(verifyAuditChain([first, { ...second, detail: 'phq9' }])).toBe(false);
  });
});
