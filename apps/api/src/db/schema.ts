import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const userRole = pgEnum('user_role', ['doctor', 'patient', 'admin']);
export const inviteStatus = pgEnum('invite_status', [
  'pending',
  'used',
  'expired',
  'blocked',
  'revoked',
]);

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    role: userRole('role').notNull(),
    email: text('email').unique(),
    credentialHash: text('credential_hash'),
    active: boolean('active').notNull().default(true),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: time('locked_until'),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (table) => [check('users_failed_attempts_nonnegative', sql`${table.failedAttempts} >= 0`)],
);

export const practitioners = pgTable('practitioners', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'restrict' }),
});
export const patients = pgTable('patients', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'restrict' }),
  createdAt: time('created_at').notNull().defaultNow(),
});
export const patientIdentity = pgTable(
  'patient_identity',
  {
    patientId: uuid('patient_id')
      .primaryKey()
      .references(() => patients.id, { onDelete: 'restrict' }),
    keyVersion: integer('key_version').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    nonce: bytea('nonce').notNull(),
    authTag: bytea('auth_tag').notNull(),
  },
  (table) => [
    check('identity_nonce_length', sql`octet_length(${table.nonce}) = 12`),
    check('identity_tag_length', sql`octet_length(${table.authTag}) = 16`),
  ],
);
export const careTeam = pgTable(
  'care_team',
  {
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    practitionerId: uuid('practitioner_id')
      .notNull()
      .references(() => practitioners.userId, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ columns: [table.patientId, table.practitionerId] }),
    index('care_team_practitioner_idx').on(table.practitionerId),
  ],
);

export const patientInvites = pgTable(
  'patient_invites',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull().unique(),
    codeHash: text('code_hash').notNull(),
    status: inviteStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: time('expires_at').notNull(),
    usedAt: time('used_at'),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('invites_patient_idx').on(table.patientId),
    uniqueIndex('one_pending_invite_per_patient')
      .on(table.patientId)
      .where(sql`${table.status} = 'pending'`),
    check('invite_attempts_range', sql`${table.attempts} between 0 and 5`),
  ],
);

export const patientDevices = pgTable(
  'patient_devices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    secretHash: text('secret_hash').notNull().unique(),
    expiresAt: time('expires_at').notNull(),
    revokedAt: time('revoked_at'),
  },
  (table) => [index('devices_user_idx').on(table.userId)],
);
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    deviceId: uuid('device_id').references(() => patientDevices.id, { onDelete: 'restrict' }),
    createdAt: time('created_at').notNull().defaultNow(),
    expiresAt: time('expires_at').notNull(),
    idleExpiresAt: time('idle_expires_at').notNull(),
    revokedAt: time('revoked_at'),
  },
  (table) => [
    index('sessions_user_idx').on(table.userId),
    index('sessions_device_idx').on(table.deviceId),
  ],
);
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'restrict' }),
    usedAt: time('used_at'),
  },
  (table) => [index('refresh_tokens_session_idx').on(table.sessionId)],
);
export const consents = pgTable(
  'consents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    version: text('version').notNull(),
    textHash: text('text_hash').notNull(),
    acceptedAt: time('accepted_at').notNull(),
    // IP is personal data too. Use the same AEAD primitive with a separate purpose.
    ipCiphertext: bytea('ip_ciphertext').notNull(),
    ipNonce: bytea('ip_nonce').notNull(),
    ipAuthTag: bytea('ip_auth_tag').notNull(),
  },
  (table) => [uniqueIndex('consents_patient_version_idx').on(table.patientId, table.version)],
);
export const auditEvents = pgTable('audit_events', {
  sequence: bigint('sequence', { mode: 'number' }).primaryKey(),
  occurredAt: time('occurred_at').notNull(),
  actorId: uuid('actor_id'),
  // Intentionally no FK: denied access to a nonexistent UUID must be auditable.
  resourceId: uuid('resource_id'),
  action: text('action').notNull(),
  previousHash: text('previous_hash').notNull(),
  hash: text('hash').notNull(),
});
