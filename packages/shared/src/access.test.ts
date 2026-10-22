import { describe, expect, it } from 'vitest';
import {
  AcceptInviteSchema,
  CreatePatientSchema,
  PatientIdentitySchema,
  PasswordSchema,
  PersonalCodeSchema,
} from './access.js';

const identity = {
  firstName: 'Тест',
  lastName: 'Сценарий',
  middleName: null,
  phone: null,
  birthDate: null,
  snils: null,
};
describe('access contracts', () => {
  it('rejects extra ownership/role fields and invalid identity types', () => {
    expect(CreatePatientSchema.safeParse({ identity, role: 'admin' }).success).toBe(false);
    expect(PatientIdentitySchema.safeParse({ ...identity, birthDate: '2039-01-01' }).success).toBe(
      false,
    );
    expect(PatientIdentitySchema.safeParse({ ...identity, firstName: '' }).success).toBe(false);
    expect(PatientIdentitySchema.safeParse(identity).success).toBe(true);
  });
  it('bounds secret lengths and does not accept consent implicitly', () => {
    expect(PasswordSchema.safeParse('short').success).toBe(false);
    expect(PasswordSchema.safeParse('x'.repeat(129)).success).toBe(false);
    expect(PersonalCodeSchema.safeParse('abcdef').success).toBe(false);
    expect(AcceptInviteSchema.safeParse({}).success).toBe(false);
  });
});
