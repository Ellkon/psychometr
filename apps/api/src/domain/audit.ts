import { desc, sql } from 'drizzle-orm';
import { type AuditAction, AuditActionSchema, IdSchema } from '@psychometr/shared';
import type { Transaction } from '../db/client.js';
import { auditEvents } from '../db/schema.js';
import { digest } from '../security/credentials.js';

export interface AuditInput {
  actorId?: string | null;
  resourceId?: string | null;
  action: AuditAction;
}
export type AuditRow = typeof auditEvents.$inferSelect;
export const GENESIS_HASH = '0'.repeat(64);
export function auditHash(row: Omit<AuditRow, 'hash'>): string {
  return digest(
    JSON.stringify([
      1,
      row.sequence,
      row.occurredAt.toISOString(),
      row.actorId,
      row.resourceId,
      row.action,
      row.previousHash,
    ]),
  );
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
    previousHash: previous?.hash ?? GENESIS_HASH,
  };
  await tx.insert(auditEvents).values({ ...row, hash: auditHash(row) });
}
export function verifyAuditChain(rows: AuditRow[]): boolean {
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
