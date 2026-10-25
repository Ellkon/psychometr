/**
 * Clinical cards for the doctor (FR-4.3–4.5): rules run after each scored answer, every
 * trigger is journaled, and each suggested action waits as a task until the doctor decides.
 */
import { and, desc, eq } from 'drizzle-orm';
import {
  CLARIFICATION_FACTS,
  type PatientCards,
  type Principal,
  type TaskDecisionInput,
} from '@psychometr/shared';
import type { Database, Transaction } from '../db/client.js';
import { observations, ruleEvaluations, tasks } from '../db/schema.js';
import { appendAudit } from './audit.js';
import type { AlertService } from './alerts.js';
import { assertCanAccessPatient, assertRole, authorized } from './access.js';
import { DomainError } from './errors.js';
import { buildFacts, type RuleEngine, type ScoreSnapshot } from './rules.js';

/** Called inside the answer transaction so a card never exists without its answer. */
export interface CardEvaluator {
  evaluate(
    tx: Transaction,
    patientId: string,
    actorId: string,
    now: Date,
    answeredScale?: string,
  ): Promise<void>;
}

export class ClinicalCardService implements CardEvaluator {
  constructor(
    private readonly db: Database,
    private readonly engine: RuleEngine,
    private readonly now: () => Date = () => new Date(),
    private readonly alerts?: AlertService,
  ) {}

  async evaluate(
    tx: Transaction,
    patientId: string,
    actorId: string,
    now: Date,
    answeredScale?: string,
  ): Promise<void> {
    const rows = await tx
      .select()
      .from(observations)
      .where(eq(observations.patientId, patientId))
      .orderBy(desc(observations.effectiveAt))
      .limit(200);
    const latest = new Map<string, ScoreSnapshot>();
    for (const row of rows) {
      if (latest.has(row.scaleId)) continue;
      latest.set(row.scaleId, {
        score: row.score,
        bandLabel: row.bandLabel,
        safetySignal: row.safetySignal,
      });
    }
    const facts = buildFacts(latest);
    for (const item of await this.engine.evaluate(facts, answeredScale)) {
      const { rule } = item;
      const [evaluation] = await tx
        .insert(ruleEvaluations)
        .values({
          patientId,
          ruleId: rule.id,
          ruleVersion: rule.version,
          severity: rule.severity,
          sourceId: rule.source_id,
          sourceLocation: rule.source_location,
          message: rule.message,
          suggestedAction: rule.suggested_action,
          facts,
          triggeredAt: now,
        })
        .returning({ id: ruleEvaluations.id });
      if (!evaluation) throw new Error('Evaluation insert failed');
      // One open task per rule: a repeated trigger is journaled but does not stack another card.
      const [open] = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .innerJoin(ruleEvaluations, eq(tasks.evaluationId, ruleEvaluations.id))
        .where(
          and(
            eq(tasks.patientId, patientId),
            eq(tasks.status, 'requested'),
            eq(ruleEvaluations.ruleId, rule.id),
          ),
        )
        .limit(1);
      if (!open) {
        await tx.insert(tasks).values({
          patientId,
          evaluationId: evaluation.id,
          status: 'requested',
          createdAt: now,
        });
      }
      // Critical alert (FR-8): same transaction as the answer, so a rollback leaves no alert.
      await this.alerts?.raise(tx, patientId, evaluation.id, rule, now);
      await appendAudit(
        tx,
        { action: 'rule.triggered', actorId, resourceId: patientId, detail: rule.id },
        now,
      );
    }
  }

  /** Doctor view of cards for a patient. Patients never see clinical cards in stage 4. */
  async list(user: Principal, patientId: string): Promise<PatientCards> {
    return authorized(
      this.db,
      user,
      async (tx: Transaction) => {
        await assertCanAccessPatient(user, patientId, tx);
        assertRole(user, 'doctor');
        const now = this.now();
        const rows = await tx
          .select({ task: tasks, evaluation: ruleEvaluations })
          .from(tasks)
          .innerJoin(ruleEvaluations, eq(tasks.evaluationId, ruleEvaluations.id))
          .where(eq(tasks.patientId, patientId))
          .orderBy(desc(ruleEvaluations.triggeredAt))
          .limit(100);
        await appendAudit(
          tx,
          { action: 'cards.viewed', actorId: user.id, resourceId: patientId },
          now,
        );
        return {
          routing: {
            status: this.engine.routingStatus(),
            activeRules: this.engine.activeCount('routing'),
          },
          clarifications: CLARIFICATION_FACTS.map((fact) => ({ key: fact.key, label: fact.label })),
          cards: rows.map(({ task, evaluation }) => ({
            taskId: task.id,
            evaluationId: evaluation.id,
            ruleId: evaluation.ruleId,
            ruleVersion: evaluation.ruleVersion,
            severity: evaluation.severity as 'info' | 'warning' | 'critical',
            message: evaluation.message,
            suggestedAction: evaluation.suggestedAction,
            sourceId: evaluation.sourceId,
            sourceLocation: evaluation.sourceLocation,
            facts: evaluation.facts,
            triggeredAt: evaluation.triggeredAt.toISOString(),
            status: task.status,
            comment: task.comment,
            decidedAt: task.decidedAt ? task.decidedAt.toISOString() : null,
          })),
        };
      },
      patientId,
    );
  }

  /** The doctor accepts or rejects a suggested action. A decision is final. */
  async decide(
    user: Principal,
    patientId: string,
    taskId: string,
    input: TaskDecisionInput,
  ): Promise<{ ok: true }> {
    return authorized(
      this.db,
      user,
      async (tx: Transaction) => {
        await assertCanAccessPatient(user, patientId, tx);
        assertRole(user, 'doctor');
        const now = this.now();
        const [updated] = await tx
          .update(tasks)
          .set({
            status: input.decision,
            comment: input.comment ?? null,
            decidedAt: now,
            decidedBy: user.id,
          })
          .where(
            and(
              eq(tasks.id, taskId),
              eq(tasks.patientId, patientId),
              eq(tasks.status, 'requested'),
            ),
          )
          .returning({ id: tasks.id });
        if (!updated) {
          const [existing] = await tx
            .select({ id: tasks.id })
            .from(tasks)
            .where(and(eq(tasks.id, taskId), eq(tasks.patientId, patientId)));
          if (!existing) throw new DomainError(404, 'task_not_found', 'Задача не найдена');
          throw new DomainError(409, 'task_already_decided', 'Задача уже закрыта');
        }
        await appendAudit(
          tx,
          {
            action: 'task.decided',
            actorId: user.id,
            resourceId: patientId,
            detail: input.decision,
          },
          now,
        );
        return { ok: true as const };
      },
      patientId,
    );
  }
}
