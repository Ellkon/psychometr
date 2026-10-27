import { z } from 'zod';

export const RoleSchema = z.enum(['doctor', 'patient', 'admin']);
export type Role = z.infer<typeof RoleSchema>;
// PostgreSQL canonicalizes UUIDs; normalize before authorization, AEAD AAD and audit hashing.
export const IdSchema = z.uuid().toLowerCase();
export const OpaqueTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const PersonalCodeSchema = z.string().regex(/^\d{6}$/, 'Введите шестизначный код');
export const PasswordSchema = z.string().min(12).max(128);
export const EmailSchema = z.email().max(254).toLowerCase();
export const SuccessSchema = z.object({ ok: z.literal(true) });

export const PrincipalSchema = z.object({
  id: IdSchema,
  role: RoleSchema,
  patientId: IdSchema.nullable(),
});
export type Principal = z.infer<typeof PrincipalSchema>;
export const AuthResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.literal(900),
  user: PrincipalSchema,
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;
export const StaffLoginSchema = z
  .object({ email: EmailSchema, password: z.string().min(1).max(128) })
  .strict();
export const PatientLoginSchema = z.object({ personalCode: PersonalCodeSchema }).strict();
export const ConsentDocumentSchema = z.object({
  version: z.string().min(1).max(100),
  text: z.string().min(1).max(100_000),
});
export type ConsentDocument = z.infer<typeof ConsentDocumentSchema>;
export const AcceptInviteSchema = z
  .object({
    token: OpaqueTokenSchema,
    code: PersonalCodeSchema,
    personalCode: PersonalCodeSchema,
    consentVersion: z.string().min(1).max(100),
    consentAccepted: z.literal(true),
  })
  .strict();

// Letters (any script) with inner spaces, hyphens, apostrophes and dots. Rejects
// digits, markup, control, zero-width and bidi-override characters.
const PersonNameSchema = z
  .string()
  .trim()
  .normalize('NFC')
  .min(1)
  .max(100)
  .regex(/^\p{L}[\p{L}\p{M} .'’-]*$/u, 'Допустимы буквы, пробел, дефис и апостроф');
// Formatting characters are allowed for readability; 10-15 digits per E.164.
const PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 ()-]{6,28}[0-9]$/)
  .refine((value) => {
    const digits = value.replace(/\D/g, '').length;
    return digits >= 10 && digits <= 15;
  }, 'Телефон должен содержать от 10 до 15 цифр');
// SNILS check digits; numbers up to 001-001-998 predate the checksum.
export function isValidSnils(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false;
  const body = value.slice(0, 9);
  if (Number(body) <= 1_001_998) return true;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(body[i]) * (9 - i);
  const check = sum < 100 ? sum : sum % 101 === 100 ? 0 : sum % 101;
  return check === Number(value.slice(9));
}

export const PatientIdentitySchema = z
  .object({
    firstName: PersonNameSchema,
    lastName: PersonNameSchema,
    middleName: PersonNameSchema.nullable(),
    phone: PhoneSchema.nullable(),
    birthDate: z.iso
      .date()
      .refine((value) => value >= '1900-01-01', 'Проверьте дату рождения')
      .refine(
        (value) => value <= new Date().toISOString().slice(0, 10),
        'Дата не может быть в будущем',
      )
      .nullable(),
    snils: z.string().refine(isValidSnils, 'Неверный СНИЛС').nullable(),
  })
  .strict();
export type PatientIdentity = z.infer<typeof PatientIdentitySchema>;
export const CreatePatientSchema = z.object({ identity: PatientIdentitySchema }).strict();
export const PatientParamsSchema = z.object({ patientId: IdSchema }).strict();
export const CreatedPatientSchema = z.object({ id: IdSchema });
export const PatientRecordSchema = z.object({ id: IdSchema, identity: PatientIdentitySchema });
export type PatientRecord = z.infer<typeof PatientRecordSchema>;
export const PatientListSchema = z.object({
  patients: z.array(z.object({ id: IdSchema, createdAt: z.iso.datetime() })),
});
export const PageQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const InviteStatusSchema = z.enum(['pending', 'used', 'expired', 'blocked', 'revoked']);
export const InviteRecordSchema = z.object({
  id: IdSchema,
  status: InviteStatusSchema,
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  usedAt: z.iso.datetime().nullable(),
  attempts: z.number().int().min(0).max(5),
});
export const InviteListSchema = z.object({ invites: z.array(InviteRecordSchema) });
export const CreatedInviteSchema = z.object({
  id: IdSchema,
  url: z.url(),
  code: PersonalCodeSchema,
  expiresAt: z.iso.datetime(),
});
export type CreatedInvite = z.infer<typeof CreatedInviteSchema>;
export const CreatePractitionerSchema = z
  .object({ email: EmailSchema, password: PasswordSchema })
  .strict();
export const AssignPractitionerSchema = z.object({ practitionerId: IdSchema }).strict();
export const CareTeamParamsSchema = PatientParamsSchema.extend({ practitionerId: IdSchema });
export const PractitionerListSchema = z.object({
  practitioners: z.array(z.object({ id: IdSchema, email: EmailSchema })),
});

export const AuditActionSchema = z.enum([
  'staff.created',
  'auth.login',
  'auth.failed',
  'auth.locked',
  'auth.refresh',
  'auth.refresh_reused',
  'auth.logout',
  'auth.denied',
  'patient.created',
  'patient.viewed',
  'patient.identity_updated',
  'invite.created',
  'invite.revoked',
  'invite.failed',
  'invite.blocked',
  'invite.expired',
  'invite.accepted',
  'consent.accepted',
  'sessions.revoked',
  'care_team.changed',
  'scale.answered',
  'scale.history_viewed',
  'scale.schedule_changed',
  'rule.triggered',
  'cards.viewed',
  'task.decided',
  'medication.prescribed',
  'medication.stopped',
  'therapy.viewed',
  'dose.marked',
  'adverse_event.reported',
  'contact_request.created',
  'contact.recorded',
  'contacts.viewed',
  'diagnosis.added',
  'diagnosis.removed',
  'diagnoses.viewed',
  'alert.created',
  'alert.acknowledged',
  'alert.escalated',
  'alert.escalation_unavailable',
  'alerts.viewed',
  'security.signal_raised',
  'security.signal_acknowledged',
  'registry.viewed',
  'timeline.viewed',
  'access.denied',
  'audit.viewed',
]);
export type AuditAction = z.infer<typeof AuditActionSchema>;
/** Optional identifier attached to an audit row: a scale id or a rule id. */
export const AuditDetailSchema = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
export const AuditEventSchema = z.object({
  sequence: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  actorId: IdSchema.nullable(),
  resourceId: IdSchema.nullable(),
  action: AuditActionSchema,
  previousHash: z.string().regex(/^[a-f0-9]{64}$/),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const AuditListSchema = z.object({ events: z.array(AuditEventSchema) });
export const AuditVerificationSchema = z.object({
  valid: z.boolean(),
  checked: z.number().int().nonnegative(),
});

export const EmptyBodySchema = z
  .object({})
  .strict()
  .nullish()
  .transform(() => ({}));
export const AuthorizationHeaderSchema = z.object({
  authorization: z
    .string()
    .max(4096)
    .regex(/^Bearer [A-Za-z0-9_.-]+$/),
});
