/**
 * Doctor's registry (FR-7.1) and patient timeline (FR-7.2). Registry rows hold facts only:
 * scores, contact gaps, due scales, missed doses. The doctor decides what they mean.
 */
import { and, asc, desc, eq, gt, inArray, isNull, max, sql } from 'drizzle-orm';
import type { Principal, Registry, RegistryRow, Timeline, TimelineEvent } from '@psychometr/shared';
import type { Database, Transaction } from '../db/client.js';
import {
  adverseEvents,
  alerts,
  contactRequests,
  contacts,
  auditEvents,
  careTeam,
  doseLog,
  medicationRequests,
  observations,
  patients,
  questionnaireResponses,
  ruleEvaluations,
  scaleSchedules,
} from '../db/schema.js';
import { appendAudit } from './audit.js';
import { assertCanAccessPatient, assertRole, authorized } from './access.js';
import { summarizeDoses } from './doses.js';
import { scheduleStatus } from './scales.js';
import { loadDoseMarks } from './therapy.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TIMELINE_LIMIT = 300;
/** Opening any of these clinical views counts as the doctor having reviewed the patient. */
const REVIEW_ACTIONS = [
  'scale.history_viewed',
  'cards.viewed',
  'therapy.viewed',
  'timeline.viewed',
];

function latest(...dates: (Date | null | undefined)[]): Date | null {
  let result: Date | null = null;
  for (const date of dates) if (date && (!result || date > result)) result = date;
  return result;
}

export class RegistryService {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async registry(user: Principal, offset: number, limit: number): Promise<Registry> {
    return authorized(this.db, user, async (tx) => {
      assertRole(user, 'doctor');
      const now = this.now();
      const members = await tx
        .select({ id: careTeam.patientId })
        .from(careTeam)
        .where(eq(careTeam.practitionerId, user.id))
        .orderBy(asc(careTeam.patientId))
        .offset(offset)
        .limit(limit);
      const rows: RegistryRow[] = [];
      for (const member of members) {
        await assertCanAccessPatient(user, member.id, tx);
        rows.push(await this.row(tx, user, member.id, now));
      }
      for (const row of rows)
        await appendAudit(
          tx,
          { action: 'registry.viewed', actorId: user.id, resourceId: row.patientId },
          now,
        );
      return { patients: rows };
    });
  }

  private async row(
    tx: Transaction,
    user: Principal,
    patientId: string,
    now: Date,
  ): Promise<RegistryRow> {
    const [patient] = await tx.select().from(patients).where(eq(patients.id, patientId));
    const scoreRows = await tx
      .select()
      .from(observations)
      .where(eq(observations.patientId, patientId))
      .orderBy(desc(observations.effectiveAt))
      .limit(200);
    const byScale = new Map<string, (typeof scoreRows)[number][]>();
    for (const score of scoreRows) {
      const list = byScale.get(score.scaleId) ?? [];
      if (list.length < 2) list.push(score);
      byScale.set(score.scaleId, list);
    }
    const scores = [...byScale.values()].flatMap(([last, previous]) =>
      last
        ? [
            {
              scaleId: last.scaleId,
              score: last.score,
              maxScore: last.maxScore,
              bandLabel: last.bandLabel,
              delta: previous ? last.score - previous.score : null,
              answeredAt: last.effectiveAt.toISOString(),
            },
          ]
        : [],
    );
    const lastPhq9 = byScale.get('phq9')?.[0];

    const schedules = await tx
      .select()
      .from(scaleSchedules)
      .where(eq(scaleSchedules.patientId, patientId));
    const answered = await tx
      .select({
        scaleId: questionnaireResponses.scaleId,
        last: max(questionnaireResponses.answeredAt),
      })
      .from(questionnaireResponses)
      .where(eq(questionnaireResponses.patientId, patientId))
      .groupBy(questionnaireResponses.scaleId);
    const lastAnswered = new Map(answered.map((row) => [row.scaleId, row.last]));
    const dueScales = schedules.filter((schedule) => {
      const status = scheduleStatus(
        schedule,
        lastAnswered.get(schedule.scaleId) ?? null,
        now,
      ).status;
      return status === 'due' || status === 'overdue';
    }).length;

    const active = await tx
      .select()
      .from(medicationRequests)
      .where(
        and(eq(medicationRequests.patientId, patientId), eq(medicationRequests.status, 'active')),
      );
    const marks = await loadDoseMarks(
      tx,
      active.map((row) => row.id),
      now,
    );
    const missedDosesInRow = Math.max(
      0,
      ...active.map((row) => summarizeDoses(row, marks.get(row.id) ?? new Map(), now).missedInRow),
    );

    const [doseActivity] = await tx
      .select({ last: max(doseLog.recordedAt) })
      .from(doseLog)
      .where(eq(doseLog.patientId, patientId));
    const [adverseActivity] = await tx
      .select({ last: max(adverseEvents.recordedAt) })
      .from(adverseEvents)
      .where(eq(adverseEvents.patientId, patientId));
    const lastActivity = latest(
      scoreRows[0]?.effectiveAt,
      doseActivity?.last,
      adverseActivity?.last,
    );
    // A doctor's recorded contact counts as contact (FR-12), but not as patient activity:
    // it must not mark the patient "not reviewed".
    const [doctorContact] = await tx
      .select({ last: max(contacts.contactedAt) })
      .from(contacts)
      .where(eq(contacts.patientId, patientId));
    const lastContact = latest(lastActivity, doctorContact?.last);
    const [openRequests] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(contactRequests)
      .where(and(eq(contactRequests.patientId, patientId), isNull(contactRequests.resolvedAt)));

    const [review] = await tx
      .select({ last: max(auditEvents.occurredAt) })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.resourceId, patientId),
          eq(auditEvents.actorId, user.id),
          inArray(auditEvents.action, REVIEW_ACTIONS),
        ),
      );
    const reviewedAt = review?.last ?? null;
    const [adverseSince] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(adverseEvents)
      .where(
        reviewedAt
          ? and(eq(adverseEvents.patientId, patientId), gt(adverseEvents.recordedAt, reviewedAt))
          : eq(adverseEvents.patientId, patientId),
      );

    const [openAlerts] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(alerts)
      .where(
        and(
          eq(alerts.patientId, patientId),
          eq(alerts.recipientId, user.id),
          // Adverse event notifications are counted as "new adverse events" above, not twice.
          eq(alerts.severity, 'critical'),
          isNull(alerts.acknowledgedAt),
        ),
      );

    return {
      patientId,
      createdAt: (patient?.createdAt ?? now).toISOString(),
      scores,
      safetySignal: lastPhq9?.safetySignal ?? false,
      lastActivityAt: lastActivity?.toISOString() ?? null,
      // A concurrent mark can be newer than `now` taken at the start of this read: never negative.
      weeksWithoutContact: lastContact
        ? Math.max(0, Math.floor((now.getTime() - lastContact.getTime()) / WEEK_MS))
        : null,
      openContactRequests: openRequests?.count ?? 0,
      dueScales,
      activeMedications: active.length,
      missedDosesInRow,
      adverseEventsSinceReview: adverseSince?.count ?? 0,
      openAlerts: openAlerts?.count ?? 0,
      reviewed: lastActivity === null || (reviewedAt !== null && reviewedAt >= lastActivity),
    };
  }

  /** Everything recorded about the patient, newest first (FR-7.2). Doctor only. */
  async timeline(user: Principal, patientId: string): Promise<Timeline> {
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx);
        assertRole(user, 'doctor');
        const now = this.now();
        const events: TimelineEvent[] = [];
        for (const row of await tx
          .select()
          .from(observations)
          .where(eq(observations.patientId, patientId))
          .orderBy(desc(observations.effectiveAt))
          .limit(TIMELINE_LIMIT))
          events.push({
            at: row.effectiveAt.toISOString(),
            kind: 'score',
            scaleId: row.scaleId,
            score: row.score,
            maxScore: row.maxScore,
            bandLabel: row.bandLabel,
            safetySignal: row.safetySignal,
          });
        const medications = await tx
          .select()
          .from(medicationRequests)
          .where(eq(medicationRequests.patientId, patientId));
        const drugById = new Map(medications.map((row) => [row.id, row.drugText]));
        for (const row of medications) {
          events.push({
            at: row.createdAt.toISOString(),
            kind: 'medication_started',
            drugText: row.drugText,
            doseText: row.doseText,
          });
          if (row.stoppedAt)
            events.push({
              at: row.stoppedAt.toISOString(),
              kind: 'medication_stopped',
              drugText: row.drugText,
              doseText: row.doseText,
            });
        }
        for (const row of await tx
          .select()
          .from(doseLog)
          .where(eq(doseLog.patientId, patientId))
          .orderBy(desc(doseLog.recordedAt))
          .limit(TIMELINE_LIMIT))
          events.push({
            at: row.recordedAt.toISOString(),
            kind: 'dose',
            drugText: drugById.get(row.medicationRequestId) ?? '',
            status: row.status,
            scheduledFor: row.scheduledFor.toISOString(),
          });
        for (const row of await tx
          .select()
          .from(adverseEvents)
          .where(eq(adverseEvents.patientId, patientId))
          .orderBy(desc(adverseEvents.recordedAt))
          .limit(TIMELINE_LIMIT))
          events.push({
            at: row.recordedAt.toISOString(),
            kind: 'adverse_event',
            description: row.description,
            severity: row.severity,
          });
        for (const row of await tx
          .select()
          .from(ruleEvaluations)
          .where(eq(ruleEvaluations.patientId, patientId))
          .orderBy(desc(ruleEvaluations.triggeredAt))
          .limit(TIMELINE_LIMIT))
          events.push({
            at: row.triggeredAt.toISOString(),
            kind: 'rule',
            ruleId: row.ruleId,
            severity: row.severity as 'info' | 'warning' | 'critical',
            message: row.message,
          });
        for (const row of await tx
          .select()
          .from(contactRequests)
          .where(eq(contactRequests.patientId, patientId))
          .orderBy(desc(contactRequests.createdAt))
          .limit(TIMELINE_LIMIT))
          events.push({
            at: row.createdAt.toISOString(),
            kind: 'contact_request',
            reason: row.reason,
            preferredTime: row.preferredTime,
            resolvedAt: row.resolvedAt?.toISOString() ?? null,
          });
        for (const row of await tx
          .select()
          .from(contacts)
          .where(eq(contacts.patientId, patientId))
          .orderBy(desc(contacts.contactedAt))
          .limit(TIMELINE_LIMIT))
          events.push({
            at: row.contactedAt.toISOString(),
            kind: 'contact',
            channel: row.channel,
            note: row.note,
          });
        // All alerts of the patient, including those sent to another doctor of the care team.
        for (const row of await tx
          .select()
          .from(alerts)
          .where(eq(alerts.patientId, patientId))
          .orderBy(desc(alerts.createdAt))
          .limit(TIMELINE_LIMIT))
          events.push({
            at: row.createdAt.toISOString(),
            kind: 'alert',
            source: row.source,
            ruleId: row.ruleId,
            message: row.message,
            status: row.status,
            acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
            escalation: row.escalationOf !== null,
          });
        await appendAudit(
          tx,
          { action: 'timeline.viewed', actorId: user.id, resourceId: patientId },
          now,
        );
        return {
          events: events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, TIMELINE_LIMIT),
        };
      },
      patientId,
    );
  }
}
