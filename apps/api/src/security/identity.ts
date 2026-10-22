import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { IdSchema, PatientIdentitySchema, type PatientIdentity } from '@psychometr/shared';

export interface EncryptedValue {
  keyVersion: number;
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
}
export class IdentityVault {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Identity key must be 32 bytes');
  }
  private seal(value: string, purpose: string): EncryptedValue {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(purpose, 'utf8'));
    return {
      keyVersion: 1,
      nonce,
      ciphertext: Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]),
      authTag: cipher.getAuthTag(),
    };
  }
  private open(value: EncryptedValue, purpose: string): string {
    if (value.keyVersion !== 1 || value.nonce.length !== 12 || value.authTag.length !== 16)
      throw new Error('Invalid encrypted value');
    const decipher = createDecipheriv('aes-256-gcm', this.key, value.nonce, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(purpose, 'utf8'));
    decipher.setAuthTag(value.authTag);
    return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString('utf8');
  }
  encrypt(patientId: string, value: PatientIdentity): EncryptedValue {
    return this.seal(
      JSON.stringify(PatientIdentitySchema.parse(value)),
      `patient_identity:v1:${IdSchema.parse(patientId)}`,
    );
  }
  decrypt(patientId: string, value: EncryptedValue): PatientIdentity {
    return PatientIdentitySchema.parse(
      JSON.parse(this.open(value, `patient_identity:v1:${IdSchema.parse(patientId)}`)),
    );
  }
  encryptConsentIp(patientId: string, version: string, ip: string): EncryptedValue {
    return this.seal(ip, `consent_ip:v1:${IdSchema.parse(patientId)}:${version}`);
  }
}
