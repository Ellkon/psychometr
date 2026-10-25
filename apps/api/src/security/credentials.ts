import { createHash, randomBytes, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

// The pinned library defaults to Argon2id/v19; tests assert that contract.
// OWASP Argon2id minimum: 19 MiB, two passes, one lane; independent random salt.
export async function hashCredential(value: string): Promise<string> {
  return hash(value, { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 });
}
export async function verifyCredential(encoded: string, value: string): Promise<boolean> {
  return encoded.startsWith('$argon2id$') && (await verify(encoded, value));
}
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}
export function newInviteCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}
export function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
