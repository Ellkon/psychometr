import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { PatientIdentitySchema } from '@psychometr/shared';
import { IdentityVault } from './identity.js';
import {
  digest,
  hashCredential,
  newInviteCode,
  newOpaqueToken,
  verifyCredential,
} from './credentials.js';
import { AccessTokens } from './access-token.js';
import { auditHash, GENESIS_HASH, verifyAuditChain } from '../domain/audit.js';

const identity = PatientIdentitySchema.parse({
  firstName: 'Тест',
  lastName: 'Синтетический',
  middleName: null,
  phone: null,
  birthDate: '2000-02-29',
  snils: null,
});
describe('AES-256-GCM identity boundary', () => {
  it('round-trips validated identity with fresh random nonces', () => {
    const vault = new IdentityVault(randomBytes(32)),
      patientId = randomUUID();
    const a = vault.encrypt(patientId, identity),
      b = vault.encrypt(patientId, identity);
    expect(a.nonce).toHaveLength(12);
    expect(a.authTag).toHaveLength(16);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.toString()).not.toContain(identity.firstName);
    expect(vault.decrypt(patientId, a)).toEqual(identity);
    expect(vault.decrypt(patientId.toUpperCase(), a)).toEqual(identity);
  });
  it('rejects changed ciphertext, another patient, another key and invalid envelopes', () => {
    const vault = new IdentityVault(randomBytes(32)),
      id = randomUUID(),
      sealed = vault.encrypt(randomUUID(), identity);
    expect(() => vault.decrypt(id, sealed)).toThrow();
    const value = vault.encrypt(id, identity);
    expect(() => new IdentityVault(randomBytes(32)).decrypt(id, value)).toThrow();
    expect(() =>
      vault.decrypt(id, { ...value, ciphertext: randomBytes(value.ciphertext.length) }),
    ).toThrow();
    expect(() => vault.decrypt(id, { ...value, keyVersion: 2 })).toThrow();
    expect(() => new IdentityVault(randomBytes(16))).toThrow();
  });
});
it('uses argon2id with independent salts and CSPRNG invitation material', async () => {
  const value = newOpaqueToken();
  const a = await hashCredential(value),
    b = await hashCredential(value);
  expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  expect(a).not.toBe(b);
  expect(await verifyCredential(a, value)).toBe(true);
  expect(await verifyCredential(a, newOpaqueToken())).toBe(false);
  expect(newOpaqueToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(newInviteCode()).toMatch(/^\d{6}$/);
  expect(digest(value)).toMatch(/^[a-f0-9]{64}$/);
});
it('JWTs expire in 15 minutes and reject wrong key, algorithm and audience', async () => {
  const key = randomBytes(32),
    user = randomUUID(),
    sid = randomUUID();
  let now = new Date();
  const tokens = new AccessTokens(key, () => now);
  const token = await tokens.sign(user, sid);
  const claims = await tokens.verify(token);
  expect(claims.exp - claims.iat).toBe(900);
  expect(claims.sub).toBe(user);
  await expect(new AccessTokens(randomBytes(32)).verify(token)).rejects.toThrow();
  const wrongAlgorithm = await new SignJWT({ sid })
    .setProtectedHeader({ alg: 'HS384', typ: 'JWT' })
    .setSubject(user)
    .setIssuedAt()
    .setIssuer('clinical-compass')
    .setAudience('clinical-compass-web')
    .setExpirationTime('15m')
    .sign(key);
  await expect(tokens.verify(wrongAlgorithm)).rejects.toThrow();
  const wrongAudience = await new SignJWT({ sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user)
    .setIssuedAt()
    .setIssuer('clinical-compass')
    .setAudience('another-app')
    .setExpirationTime('15m')
    .sign(key);
  await expect(tokens.verify(wrongAudience)).rejects.toThrow();
  now = new Date(now.getTime() + 900_001);
  await expect(tokens.verify(token)).rejects.toThrow();
});
it('detects modification and reordering in the audit hash chain', () => {
  const first = {
    sequence: 1,
    occurredAt: new Date(),
    actorId: null,
    resourceId: null,
    action: 'auth.failed',
    previousHash: GENESIS_HASH,
  };
  const a = { ...first, hash: auditHash(first) };
  const second = { ...first, sequence: 2, previousHash: a.hash };
  const b = { ...second, hash: auditHash(second) };
  expect(verifyAuditChain([a, b])).toBe(true);
  expect(verifyAuditChain([b, a])).toBe(false);
  expect(verifyAuditChain([a, { ...b, action: 'auth.login' }])).toBe(false);
});
