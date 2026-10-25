import { desc, sql } from 'drizzle-orm';
import {
  type AuditAction,
  AuditActionSchema,
  AuditDetailSchema,
  IdSchema,
} from '@psychometr/shared';
import type { Transaction } from '../db/client.js';
import { auditEvents } from '../db/schema.js';
import { digest } from '../security/credentials.js';

export interface AuditInput {
  actorId?: string | null;
  resourceId?: string | null;
  action: AuditAction;
  /** Scale identifier for scale actions; validated and hashed. */
  detail?: string | null;
}
export type AuditRow = typeof auditEvents.$inferSelect;
/** Rows written before `detail` existed have no such property; they hash without it. */
export type AuditChainRow = Omit<AuditRow, 'detail' | 'hash'> & {
  detail?: string | null;
  hash?: string;
};
export const GENESIS_HASH = '0'.repeat(64);
export function auditHash(row: AuditChainRow): string {
  const fields: unknown[] = [
    1,
    row.sequence,
    row.occurredAt.toISOString(),
    row.actorId,
    row.resourceId,
    row.action,
    row.previousHash,
  ];
  // Old rows have no detail and keep the exact pre-stage-3 digest input.
  if (row.detail !== null && row.detail !== undefined) fields.push(row.detail);
  return digest(JSON.stringify(fields));
}
export async function appendAudit(
  tx: Transaction,
  input: AuditInput,
  now = new Date(),
): Promise<void> {
  // A transaction-scoped lock serializes chain appends across all API instances.
  await tx.execute(sql`select pg_advisory_xact_lock(51982731)`);
  const [previous] = await tx
    .select()
    .from(auditEvents)
    .orderBy(desc(auditEvents.sequence))
    .limit(1);
  const row = {
    sequence: (previous?.sequence ?? 0) + 1,
    occurredAt: now,
    actorId: input.actorId ? IdSchema.parse(input.actorId) : null,
    resourceId: input.resourceId ? IdSchema.parse(input.resourceId) : null,
    action: AuditActionSchema.parse(input.action),
    detail:
      input.detail === undefined || input.detail === null
        ? null
        : AuditDetailSchema.parse(input.detail),
    previousHash: previous?.hash ?? GENESIS_HASH,
  };
  await tx.insert(auditEvents).values({ ...row, hash: auditHash(row) });
}
export function verifyAuditChain(rows: AuditChainRow[]): boolean {
  let previousHash = GENESIS_HASH;
  let sequence = 1;
  for (const row of rows) {
    if (
      row.sequence !== sequence ||
      row.previousHash !== previousHash ||
      row.hash !== auditHash(row)
    )
      return false;
    previousHash = row.hash;
    sequence += 1;
  }
  return true;
}
