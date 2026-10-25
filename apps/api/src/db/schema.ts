import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  date,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
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
    /** Order of assignment: the first practitioner is the primary alert recipient (FR-8.3). */
    assignedAt: time('assigned_at').notNull().defaultNow(),
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
export const auditEvents = pgTable(
  'audit_events',
  {
    sequence: bigint('sequence', { mode: 'number' }).primaryKey(),
    occurredAt: time('occurred_at').notNull(),
    actorId: uuid('actor_id'),
    // Intentionally no FK: denied access to a nonexistent UUID must be auditable.
    resourceId: uuid('resource_id'),
    action: text('action').notNull(),
    // Optional, hashed only when present, so rows written before this column keep their hash.
    detail: text('detail'),
    previousHash: text('previous_hash').notNull(),
    hash: text('hash').notNull(),
  },
  // Registry looks up when a doctor last opened a patient (FR-7.1).
  (table) => [index('audit_events_resource_actor_idx').on(table.resourceId, table.actorId)],
);

/** Врач задаёт расписание шкалы пациенту (FR-3.4). Одна строка на пару пациент–шкала. */
export const scaleSchedules = pgTable(
  'scale_schedules',
  {
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    scaleId: text('scale_id').notNull(),
    intervalDays: integer('interval_days').notNull(),
    windowDays: integer('window_days').notNull(),
    active: boolean('active').notNull().default(true),
    startsAt: time('starts_at').notNull(),
    updatedAt: time('updated_at').notNull().defaultNow(),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ columns: [table.patientId, table.scaleId] }),
    check('schedule_interval_range', sql`${table.intervalDays} between 1 and 365`),
    check('schedule_window_range', sql`${table.windowDays} between 1 and 90`),
  ],
);

/** Ответы пациента на шкалу. Append-only: исправление = новый ответ, старый не меняется. */
export const questionnaireResponses = pgTable(
  'questionnaire_responses',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    /** Client-generated per form fill; makes a retried send idempotent. */
    submissionId: uuid('submission_id').notNull(),
    scaleId: text('scale_id').notNull(),
    scaleVersion: text('scale_version').notNull(),
    answers: jsonb('answers').$type<Record<string, number>>().notNull(),
    functionalAnswer: integer('functional_answer'),
    answeredAt: time('answered_at').notNull(),
  },
  (table) => [
    index('responses_patient_scale_idx').on(table.patientId, table.scaleId, table.answeredAt),
    uniqueIndex('responses_patient_submission_idx').on(table.patientId, table.submissionId),
    check('responses_functional_range', sql`${table.functionalAnswer} between 0 and 3`),
  ],
);

/** Рассчитанный на сервере балл (FR-3.3). Append-only. */
export const observations = pgTable(
  'observations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    responseId: uuid('response_id')
      .notNull()
      .unique()
      .references(() => questionnaireResponses.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    scaleId: text('scale_id').notNull(),
    score: integer('score').notNull(),
    maxScore: integer('max_score').notNull(),
    bandLabel: text('band_label').notNull(),
    /** PHQ-9 item 9 > 0: input for the critical alert (stage 6, FR-5.3). */
    safetySignal: boolean('safety_signal').notNull().default(false),
    effectiveAt: time('effective_at').notNull(),
  },
  (table) => [
    index('observations_patient_scale_idx').on(table.patientId, table.scaleId, table.effectiveAt),
    check('observations_score_range', sql`${table.score} between 0 and ${table.maxScore}`),
  ],
);

/**
 * Журнал срабатываний правил (FR-4.5). Append-only. Текст правила и факты фиксируются
 * на момент срабатывания, чтобы последующая смена версии не меняла прошлые карточки.
 */
export const ruleEvaluations = pgTable(
  'rule_evaluations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    ruleId: text('rule_id').notNull(),
    ruleVersion: text('rule_version').notNull(),
    severity: text('severity').notNull(),
    sourceId: text('source_id').notNull(),
    sourceLocation: text('source_location').notNull(),
    message: text('message').notNull(),
    suggestedAction: text('suggested_action').notNull(),
    facts: jsonb('facts').$type<Record<string, string | number | boolean>>().notNull(),
    triggeredAt: time('triggered_at').notNull(),
  },
  (table) => [
    index('rule_evaluations_patient_idx').on(table.patientId, table.triggeredAt),
    check('rule_evaluations_severity', sql`${table.severity} in ('info', 'warning', 'critical')`),
  ],
);

/**
 * Задача врача: предлагаемое действие требует подтверждения (FR-4.4).
 * requested → accepted | rejected; переход проверяется триггером БД.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    evaluationId: uuid('evaluation_id')
      .notNull()
      .unique()
      .references(() => ruleEvaluations.id, { onDelete: 'restrict' }),
    status: text('status').$type<'requested' | 'accepted' | 'rejected'>().notNull(),
    comment: text('comment'),
    createdAt: time('created_at').notNull(),
    decidedAt: time('decided_at'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'restrict' }),
  },
  (table) => [
    index('tasks_patient_status_idx').on(table.patientId, table.status),
    check('tasks_status', sql`${table.status} in ('requested', 'accepted', 'rejected')`),
    check(
      'tasks_decision_consistent',
      sql`(${table.status} = 'requested' and ${table.decidedAt} is null) or (${table.status} <> 'requested' and ${table.decidedAt} is not null)`,
    ),
    check(
      'tasks_comment_length',
      sql`${table.comment} is null or length(${table.comment}) <= 1000`,
    ),
  ],
);

/**
 * Назначение, которое внёс врач (FR-6, FR-7.2). Система не назначает лечение: она фиксирует
 * то, что врач уже назначил. Препарат выбирается из снимка ГРЛС или вводится текстом.
 * Изменение схемы приёма = остановка и новое назначение; меняется только статус.
 */
export const medicationRequests = pgTable(
  'medication_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    /** ГРЛС registration number when chosen from the snapshot; null for free text. */
    grlsRegNumber: text('grls_reg_number'),
    drugText: text('drug_text').notNull(),
    doseText: text('dose_text').notNull(),
    /** Local intake times "HH:MM", sorted and unique. */
    doseTimes: jsonb('dose_times').$type<string[]>().notNull(),
    timeZone: text('time_zone').notNull(),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }),
    status: text('status').$type<'active' | 'stopped'>().notNull(),
    createdAt: time('created_at').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    stoppedAt: time('stopped_at'),
    stoppedBy: uuid('stopped_by').references(() => users.id, { onDelete: 'restrict' }),
  },
  (table) => [
    index('medication_requests_patient_idx').on(table.patientId, table.status),
    check('medication_requests_status', sql`${table.status} in ('active', 'stopped')`),
    check(
      'medication_requests_stop_consistent',
      sql`(${table.status} = 'active' and ${table.stoppedAt} is null) or (${table.status} = 'stopped' and ${table.stoppedAt} is not null)`,
    ),
    check(
      'medication_requests_period',
      sql`${table.endsOn} is null or ${table.endsOn} >= ${table.startsOn}`,
    ),
  ],
);

/** Отметка приёма или пропуска дозы пациентом (FR-6). Append-only, одна отметка на слот. */
export const doseLog = pgTable(
  'dose_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    medicationRequestId: uuid('medication_request_id')
      .notNull()
      .references(() => medicationRequests.id, { onDelete: 'restrict' }),
    scheduledFor: time('scheduled_for').notNull(),
    status: text('status').$type<'taken' | 'skipped'>().notNull(),
    recordedAt: time('recorded_at').notNull(),
  },
  (table) => [
    uniqueIndex('dose_log_slot_idx').on(table.medicationRequestId, table.scheduledFor),
    index('dose_log_patient_idx').on(table.patientId, table.scheduledFor),
    check('dose_log_status', sql`${table.status} in ('taken', 'skipped')`),
  ],
);

/** Нежелательное явление со слов пациента (FR-6). Append-only. */
export const adverseEvents = pgTable(
  'adverse_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    /** Client-generated per form fill; makes a retried send idempotent. */
    submissionId: uuid('submission_id').notNull(),
    medicationRequestId: uuid('medication_request_id').references(() => medicationRequests.id, {
      onDelete: 'restrict',
    }),
    description: text('description').notNull(),
    severity: text('severity').$type<'mild' | 'moderate' | 'severe'>().notNull(),
    startedOn: date('started_on', { mode: 'string' }).notNull(),
    recordedAt: time('recorded_at').notNull(),
  },
  (table) => [
    uniqueIndex('adverse_events_submission_idx').on(table.patientId, table.submissionId),
    index('adverse_events_patient_idx').on(table.patientId, table.recordedAt),
    check('adverse_events_severity', sql`${table.severity} in ('mild', 'moderate', 'severe')`),
    check('adverse_events_description_length', sql`length(${table.description}) <= 1000`),
  ],
);

/**
 * Критичный алерт врачу (FR-8). Строка одновременно является transactional outbox: её создают
 * в той же транзакции, что и срабатывание critical-правила. Текст берётся из правила
 * (content/rules). Содержимое неизменно; меняются только таймстемпы переходов и эскалация
 * (проверяется триггером).
 */
export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => practitioners.userId, { onDelete: 'restrict' }),
    evaluationId: uuid('evaluation_id')
      .notNull()
      .references(() => ruleEvaluations.id, { onDelete: 'restrict' }),
    ruleId: text('rule_id').notNull(),
    severity: text('severity').notNull(),
    message: text('message').notNull(),
    suggestedAction: text('suggested_action').notNull(),
    status: text('status').$type<'pending' | 'sent' | 'delivered' | 'acknowledged'>().notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    escalationOf: uuid('escalation_of').references((): AnyPgColumn => alerts.id, {
      onDelete: 'restrict',
    }),
    createdAt: time('created_at').notNull().defaultNow(),
    /** Set once at creation for a primary alert; cleared when escalated or when no reserve exists. */
    escalateAt: time('escalate_at'),
    escalatedAt: time('escalated_at'),
    sentAt: time('sent_at'),
    attemptedAt: time('attempted_at'),
    deliveredAt: time('delivered_at'),
    acknowledgedAt: time('acknowledged_at'),
    acknowledgedBy: uuid('acknowledged_by').references(() => users.id, { onDelete: 'restrict' }),
  },
  (table) => [
    index('alerts_recipient_idx').on(table.recipientId, table.status),
    index('alerts_escalation_idx').on(table.escalateAt),
    check(
      'alerts_status_valid',
      sql`${table.status} in ('pending', 'sent', 'delivered', 'acknowledged')`,
    ),
    check('alerts_severity_valid', sql`${table.severity} = 'critical'`),
  ],
);
