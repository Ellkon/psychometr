import { and, eq, sql } from 'drizzle-orm';
import type { Principal } from '@psychometr/shared';
import type { Database, Transaction } from '../db/client.js';
import { careTeam } from '../db/schema.js';
import { appendAudit } from './audit.js';
import { AccessDenied, unwrap, type Outcome } from './errors.js';

/** The only patient authorization boundary. Admin assignment rights are NOT clinical access. */
export async function assertCanAccessPatient(
  user: Principal,
  patientId: string,
  tx: Transaction,
  purpose: 'clinical' | 'assignment' | 'create' = 'clinical',
): Promise<void> {
  if (purpose === 'create') {
    if (user.role === 'doctor') return;
    throw new AccessDenied();
  }
  if (purpose === 'assignment') {
    if (user.role === 'admin') return;
    throw new AccessDenied();
  }
  if (user.role === 'patient' && user.patientId === patientId) return;
  if (user.role === 'doctor') {
    const [membership] = await tx
      .select()
      .from(careTeam)
      .where(and(eq(careTeam.patientId, patientId), eq(careTeam.practitionerId, user.id)))
      .for('share');
    if (membership) return;
  }
  throw new AccessDenied();
}

/** Access denials commit their audit record; unexpected errors still roll back. */
export async function authorized<T>(
  db: Database,
  user: Principal,
  work: (tx: Transaction) => Promise<T>,
  resourceId?: string,
): Promise<T> {
  const outcome: Outcome<T> = await db.transaction(async (tx): Promise<Outcome<T>> => {
    // Acquire before membership locks, consistently across all patient operations.
    if (resourceId) await lockPatient(tx, resourceId);
    try {
      return { value: await work(tx) };
    } catch (error) {
      if (!(error instanceof AccessDenied)) throw error;
      await appendAudit(tx, { action: 'access.denied', actorId: user.id, resourceId });
      return { error };
    }
  });
  return unwrap(outcome);
}
export function assertRole(user: Principal, role: 'doctor' | 'admin'): void {
  if (user.role !== role) throw new AccessDenied();
}

export async function lockPatient(tx: Transaction, patientId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${patientId}, 73))`);
}
