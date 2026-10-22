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

export const PatientIdentitySchema = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    middleName: z.string().trim().max(100).nullable(),
    phone: z
      .string()
      .regex(/^\+?[0-9 ()-]{7,30}$/)
      .nullable(),
    birthDate: z.iso
      .date()
      .refine(
        (value) => value <= new Date().toISOString().slice(0, 10),
        'Дата не может быть в будущем',
      )
      .nullable(),
    snils: z
      .string()
      .regex(/^\d{11}$/)
      .nullable(),
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
  'access.denied',
  'audit.viewed',
]);
export type AuditAction = z.infer<typeof AuditActionSchema>;
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
