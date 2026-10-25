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
  it('rejects markup, control and bidi characters in names', () => {
    for (const firstName of ['<script>', 'Анна\u202E', 'A\u200Bnna', 'Анна1', ' ', "'Анна"])
      expect(PatientIdentitySchema.safeParse({ ...identity, firstName }).success).toBe(false);
    for (const lastName of ['Салтыков-Щедрин', "O'Brien", 'Иванова'])
      expect(PatientIdentitySchema.safeParse({ ...identity, lastName }).success).toBe(true);
  });
  it('validates phone digit count, birth date range and SNILS checksum', () => {
    const check = (patch: Partial<typeof identity> | Record<string, string>) =>
      PatientIdentitySchema.safeParse({ ...identity, ...patch }).success;
    expect(check({ phone: '+7 (900) 123-45-67' })).toBe(true);
    expect(check({ phone: '((((((((' })).toBe(false);
    expect(check({ phone: '1234567' })).toBe(false);
    expect(check({ birthDate: '1899-12-31' })).toBe(false);
    expect(check({ snils: '11223344595' })).toBe(true);
    expect(check({ snils: '11223344596' })).toBe(false);
  });
});
