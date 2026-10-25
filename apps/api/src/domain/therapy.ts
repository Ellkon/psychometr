/**
 * Therapy diary (FR-6): prescriptions the doctor records, dose marks and adverse events
 * the patient reports. The system never chooses a drug or a dose.
 */
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type {
  AdverseEventInput,
  DoseMarkInput,
  MedicationInput,
  PatientTherapy,
  Principal,
} from '@psychometr/shared';
import type { Database, Transaction } from '../db/client.js';
import { adverseEvents, doseLog, medicationRequests } from '../db/schema.js';
import { appendAudit } from './audit.js';
import { assertCanAccessPatient, assertRole, authorized } from './access.js';
import type { AlertService } from './alerts.js';
import type { DrugRegistry } from './drugs.js';
import {
  ADHERENCE_DAYS,
  MARK_LATE_MS,
  isMarkableSlot,
  summarizeDoses,
  type DoseStatus,
} from './doses.js';
import { DomainError } from './errors.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MEDICATION_LIMIT = 50;
const ADVERSE_LIMIT = 100;

type MedicationRow = typeof medicationRequests.$inferSelect;

/** Marks needed to summarize these prescriptions at `now`, keyed by prescription. */
export async function loadDoseMarks(
  tx: Transaction,
  medicationIds: readonly string[],
  now: Date,
): Promise<Map<string, Map<number, DoseStatus>>> {
  const marks = new Map<string, Map<number, DoseStatus>>();
  if (medicationIds.length === 0) return marks;
  const since = new Date(now.getTime() - Math.max(ADHERENCE_DAYS * DAY_MS, MARK_LATE_MS) - DAY_MS);
  const rows = await tx
    .select({
      medicationRequestId: doseLog.medicationRequestId,
      scheduledFor: doseLog.scheduledFor,
      status: doseLog.status,
    })
    .from(doseLog)
    .where(
      and(
        inArray(doseLog.medicationRequestId, [...medicationIds]),
        gte(doseLog.scheduledFor, since),
      ),
    );
  for (const row of rows) {
    let byMedication = marks.get(row.medicationRequestId);
    if (!byMedication)
      marks.set(row.medicationRequestId, (byMedication = new Map<number, DoseStatus>()));
    byMedication.set(row.scheduledFor.getTime(), row.status);
  }
  return marks;
}

export class TherapyService {
  constructor(
    private readonly db: Database,
    private readonly drugs: DrugRegistry,
    private readonly now: () => Date = () => new Date(),
    /** Notifies the doctor of each adverse event report (FR-6). Optional in unit tests. */
    private readonly alerts?: AlertService,
  ) {}

  catalog(user: Principal) {
    assertRole(user, 'doctor');
    return this.drugs.catalog;
  }

  /** The doctor records a prescription they made (FR-6). */
  async prescribe(user: Principal, patientId: string, input: MedicationInput) {
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx);
        assertRole(user, 'doctor');
        if (input.grlsRegNumber !== null && !this.drugs.byRegNumber.has(input.grlsRegNumber))
          throw new DomainError(400, 'unknown_drug', 'Препарат не найден в справочнике ГРЛС');
        const now = this.now();
        const [row] = await tx
          .insert(medicationRequests)
          .values({
            patientId,
            grlsRegNumber: input.grlsRegNumber,
            drugText: input.drugText,
            doseText: input.doseText,
            doseTimes: input.doseTimes,
            timeZone: input.timeZone,
            startsOn: input.startsOn,
            endsOn: input.endsOn,
            status: 'active',
            createdAt: now,
            createdBy: user.id,
          })
          .returning({ id: medicationRequests.id });
        if (!row) throw new Error('Medication insert failed');
        await appendAudit(
          tx,
          { action: 'medication.prescribed', actorId: user.id, resourceId: patientId },
          now,
        );
        return { id: row.id };
      },
      patientId,
    );
  }

  /** Stopping is final; a changed regimen is a new prescription. */
  async stop(user: Principal, patientId: string, medicationId: string) {
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx);
        assertRole(user, 'doctor');
        const now = this.now();
        const [updated] = await tx
          .update(medicationRequests)
          .set({ status: 'stopped', stoppedAt: now, stoppedBy: user.id })
          .where(
            and(
              eq(medicationRequests.id, medicationId),
              eq(medicationRequests.patientId, patientId),
              eq(medicationRequests.status, 'active'),
            ),
          )
          .returning({ id: medicationRequests.id });
        if (!updated) {
          await this.requireMedication(tx, patientId, medicationId);
          throw new DomainError(409, 'medication_stopped', 'Назначение уже остановлено');
        }
        await appendAudit(
          tx,
          { action: 'medication.stopped', actorId: user.id, resourceId: patientId },
          now,
        );
        return { ok: true as const };
      },
      patientId,
    );
  }

  /** Doctor and the patient see prescriptions, dose summaries and adverse events. */
  async list(user: Principal, patientId: string): Promise<PatientTherapy> {
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx);
        const now = this.now();
        const rows = await tx
          .select()
          .from(medicationRequests)
          .where(eq(medicationRequests.patientId, patientId))
          .orderBy(medicationRequests.status, desc(medicationRequests.createdAt))
          .limit(MEDICATION_LIMIT);
        const marks = await loadDoseMarks(
          tx,
          rows.map((row) => row.id),
          now,
        );
        const events = await tx
          .select()
          .from(adverseEvents)
          .where(eq(adverseEvents.patientId, patientId))
          .orderBy(desc(adverseEvents.recordedAt))
          .limit(ADVERSE_LIMIT);
        await appendAudit(
          tx,
          { action: 'therapy.viewed', actorId: user.id, resourceId: patientId },
          now,
        );
        return {
          medications: rows.map((row) => ({
            id: row.id,
            grlsRegNumber: row.grlsRegNumber,
            drugText: row.drugText,
            doseText: row.doseText,
            doseTimes: row.doseTimes,
            timeZone: row.timeZone,
            startsOn: row.startsOn,
            endsOn: row.endsOn,
            status: row.status,
            createdAt: row.createdAt.toISOString(),
            stoppedAt: row.stoppedAt?.toISOString() ?? null,
            ...summarizeDoses(row, marks.get(row.id) ?? new Map(), now),
          })),
          adverseEvents: events.map((event) => ({
            id: event.id,
            description: event.description,
            severity: event.severity,
            startedOn: event.startedOn,
            recordedAt: event.recordedAt.toISOString(),
            medicationRequestId: event.medicationRequestId,
          })),
        };
      },
      patientId,
    );
  }

  /** One tap per dose. Repeating the same mark is a no-op; changing it is refused. */
  async markDose(user: Principal, patientId: string, medicationId: string, input: DoseMarkInput) {
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx);
        assertRole(user, 'patient');
        const medication = await this.requireMedication(tx, patientId, medicationId);
        const now = this.now();
        const slot = new Date(input.scheduledFor);
        if (!isMarkableSlot(medication, slot, now))
          throw new DomainError(400, 'invalid_slot', 'Эту дозу сейчас нельзя отметить');
        const [inserted] = await tx
          .insert(doseLog)
          .values({
            patientId,
            medicationRequestId: medicationId,
            scheduledFor: slot,
            status: input.status,
            recordedAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: doseLog.id });
        if (!inserted) {
          const [existing] = await tx
            .select({ status: doseLog.status })
            .from(doseLog)
            .where(
              and(eq(doseLog.medicationRequestId, medicationId), eq(doseLog.scheduledFor, slot)),
            );
          if (existing?.status !== input.status)
            throw new DomainError(409, 'dose_already_marked', 'Эта доза уже отмечена');
          return { ok: true as const };
        }
        await appendAudit(
          tx,
          { action: 'dose.marked', actorId: user.id, resourceId: patientId, detail: input.status },
          now,
        );
        return { ok: true as const };
      },
      patientId,
    );
  }

  async reportAdverseEvent(user: Principal, patientId: string, input: AdverseEventInput) {
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx);
        assertRole(user, 'patient');
        const now = this.now();
        // The patient's local date may run up to 14 hours ahead of UTC.
        if (
          input.startedOn > new Date(now.getTime() + 14 * 60 * 60 * 1000).toISOString().slice(0, 10)
        )
          throw new DomainError(400, 'invalid_date', 'Дата начала не может быть в будущем');
        if (input.medicationRequestId !== null)
          await this.requireMedication(tx, patientId, input.medicationRequestId);
        const [stored] = await tx
          .select({ id: adverseEvents.id })
          .from(adverseEvents)
          .where(
            and(
              eq(adverseEvents.patientId, patientId),
              eq(adverseEvents.submissionId, input.submissionId),
            ),
          );
        if (stored) return { id: stored.id };
        const [row] = await tx
          .insert(adverseEvents)
          .values({
            patientId,
            submissionId: input.submissionId,
            medicationRequestId: input.medicationRequestId,
            description: input.description,
            severity: input.severity,
            startedOn: input.startedOn,
            recordedAt: now,
          })
          .returning({ id: adverseEvents.id });
        if (!row) throw new Error('Adverse event insert failed');
        await appendAudit(
          tx,
          {
            action: 'adverse_event.reported',
            actorId: user.id,
            resourceId: patientId,
            detail: input.severity,
          },
          now,
        );
        await this.alerts?.raiseAdverseEvent(tx, patientId, row.id, input.severity, now);
        return { id: row.id };
      },
      patientId,
    );
  }

  private async requireMedication(
    tx: Transaction,
    patientId: string,
    medicationId: string,
  ): Promise<MedicationRow> {
    const [row] = await tx
      .select()
      .from(medicationRequests)
      .where(
        and(eq(medicationRequests.id, medicationId), eq(medicationRequests.patientId, patientId)),
      );
    if (!row) throw new DomainError(404, 'medication_not_found', 'Назначение не найдено');
    return row;
  }
}
