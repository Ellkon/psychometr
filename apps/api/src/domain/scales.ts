/* eslint-disable security/detect-non-literal-fs-filename -- Content directory is deployment-only; scale file names come from readdir, never from request input. */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  ANSWER_MAX,
  ScaleFileSchema,
  SourcesFileSchema,
  type Principal,
  type PatientScales,
  type ScaleDefinition,
  type ScaleFile,
  type ScaleResult,
  type ScaleScheduleInput,
  type ScaleSubmission,
} from '@psychometr/shared';
import type { Database, Transaction } from '../db/client.js';
import { observations, questionnaireResponses, scaleSchedules } from '../db/schema.js';
import { appendAudit } from './audit.js';
import { assertCanAccessPatient, assertRole, authorized } from './access.js';
import { DomainError } from './errors.js';
import type { CardEvaluator } from './cards.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LoadedScale {
  readonly file: ScaleFile;
  readonly definition: ScaleDefinition;
}
export interface ScaleCatalog {
  readonly scales: ReadonlyMap<string, LoadedScale>;
}

/** Finds the repository/image `content/` directory by walking up from this module. */
export function findContentDir(start = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, 'content');
    if (existsSync(path.join(candidate, 'sources.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('content/ directory not found');
    dir = parent;
  }
}

function toDefinition(file: ScaleFile): ScaleDefinition {
  const { passport } = file;
  return {
    id: passport.id,
    title: passport.title,
    version: passport.version,
    validationCitation: passport.validation_citation_ru,
    licenseStatus: passport.license_status,
    recallWeeks: passport.recall_period.weeks,
    stem: file.stem,
    answerOptions: file.answer_options.map((option) => ({ ...option })),
    items: file.items.map((item) => ({ id: item.id, text: item.text })),
    functionalItem: file.functional_item
      ? {
          id: file.functional_item.id,
          text: file.functional_item.text,
          options: file.functional_item.options.map((option) => ({ ...option })),
        }
      : null,
    cutoffs: file.cutoffs.map((band) => ({ ...band })),
    maxScore: file.items.length * ANSWER_MAX,
    interpretationNote: file.interpretation_note,
    hasSafetyItem: file.safety_item !== null,
  };
}

/**
 * Loads and cross-checks content/scales. Any broken file stops startup: a scale
 * with wrong text or thresholds must never reach a patient (NFR-6, AGENTS.md).
 */
export async function loadScaleCatalog(contentDir = findContentDir()): Promise<ScaleCatalog> {
  const sources = SourcesFileSchema.parse(
    JSON.parse(await readFile(path.join(contentDir, 'sources.json'), 'utf8')),
  );
  const sourceIds = new Set(sources.sources.map((source) => source.id));
  const scalesDir = path.join(contentDir, 'scales');
  const names = (await readdir(scalesDir)).filter((name) => name.endsWith('.ru.json')).sort();
  const scales = new Map<string, LoadedScale>();
  for (const name of names) {
    const file = ScaleFileSchema.parse(
      JSON.parse(await readFile(path.join(scalesDir, name), 'utf8')),
    );
    const { passport } = file;
    if (name !== `${passport.id}.ru.json`) throw new Error(`Scale file name mismatch: ${name}`);
    if (scales.has(passport.id)) throw new Error(`Duplicate scale id: ${passport.id}`);
    for (const id of [
      ...passport.source_ids,
      passport.text_source_id,
      passport.license_source_id,
    ]) {
      if (!sourceIds.has(id)) throw new Error(`Scale ${passport.id} cites unknown source ${id}`);
    }
    scales.set(passport.id, { file, definition: toDefinition(file) });
  }
  if (scales.size === 0) throw new Error('No scale files loaded');
  return { scales };
}

export interface ScoreResult {
  readonly score: number;
  readonly maxScore: number;
  readonly bandLabel: string;
  readonly safetySignal: boolean;
}

/** Pure scoring. Callers must have validated the submission first. */
export function scoreScale(file: ScaleFile, answers: Record<string, number>): ScoreResult {
  let score = 0;
  for (const item of file.items) {
    const value = answers[item.id];
    if (value === undefined) throw new Error(`Missing answer for ${item.id}`);
    score += value;
  }
  const maxScore = file.items.length * ANSWER_MAX;
  const band = file.cutoffs.find((candidate) => score >= candidate.min && score <= candidate.max);
  if (!band) throw new Error('Score outside configured bands');
  const safety = file.safety_item;
  const safetySignal = safety !== null && (answers[safety.item_id] ?? 0) > safety.positive_above;
  return { score, maxScore, bandLabel: band.label, safetySignal };
}

/** Every scored item must be answered; nothing unknown is accepted. */
export function validateSubmission(
  file: ScaleFile,
  submission: Pick<ScaleSubmission, 'answers' | 'functionalAnswer'>,
): void {
  const expected = new Set(file.items.map((item) => item.id));
  const given = Object.keys(submission.answers);
  const complete = given.length === expected.size && given.every((id) => expected.has(id));
  if (!complete)
    throw new DomainError(
      400,
      'invalid_answers',
      'Ответьте на все вопросы шкалы, без лишних полей',
    );
  if (submission.functionalAnswer !== null && file.functional_item === null)
    throw new DomainError(400, 'invalid_answers', 'У этой шкалы нет дополнительного вопроса');
}

export function scheduleStatus(
  schedule: { active: boolean; intervalDays: number; windowDays: number; startsAt: Date },
  lastAnsweredAt: Date | null,
  now: Date,
): { status: PatientScales['schedules'][number]['status']; dueAt: Date } {
  const dueAt = lastAnsweredAt
    ? new Date(lastAnsweredAt.getTime() + schedule.intervalDays * DAY_MS)
    : schedule.startsAt;
  if (!schedule.active) return { status: 'paused', dueAt };
  if (now.getTime() < dueAt.getTime()) return { status: 'scheduled', dueAt };
  if (now.getTime() <= dueAt.getTime() + schedule.windowDays * DAY_MS)
    return { status: 'due', dueAt };
  return { status: 'overdue', dueAt };
}

const HISTORY_LIMIT = 100;

export class ScaleService {
  constructor(
    private readonly db: Database,
    private readonly catalog: ScaleCatalog,
    private readonly now: () => Date = () => new Date(),
    private readonly cards?: CardEvaluator,
  ) {}

  definitions(): ScaleDefinition[] {
    return [...this.catalog.scales.values()].map((scale) => scale.definition);
  }

  private requireScale(scaleId: string): LoadedScale {
    const scale = this.catalog.scales.get(scaleId);
    if (!scale) throw new DomainError(404, 'not_found', 'Шкала не найдена');
    return scale;
  }

  /** Clinical read: schedules and score history. Patients see their own; care team sees theirs. */
  async list(user: Principal, patientId: string): Promise<PatientScales> {
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx);
        const now = this.now();
        const schedules = await tx
          .select()
          .from(scaleSchedules)
          .where(eq(scaleSchedules.patientId, patientId));
        const lastRows = await tx
          .select({
            scaleId: questionnaireResponses.scaleId,
            // Raw aggregates may come back as strings; normalize to Date explicitly.
            last: sql<Date>`max(${questionnaireResponses.answeredAt})`.mapWith(
              (value: unknown) => new Date(String(value)),
            ),
          })
          .from(questionnaireResponses)
          .where(eq(questionnaireResponses.patientId, patientId))
          .groupBy(questionnaireResponses.scaleId);
        const lastByScale = new Map(lastRows.map((row) => [row.scaleId, row.last]));
        const history = await tx
          .select()
          .from(observations)
          .where(eq(observations.patientId, patientId))
          .orderBy(desc(observations.effectiveAt))
          .limit(HISTORY_LIMIT);
        await appendAudit(
          tx,
          { action: 'scale.history_viewed', actorId: user.id, resourceId: patientId },
          now,
        );
        return {
          schedules: schedules
            .flatMap((row) => {
              const scale = this.catalog.scales.get(row.scaleId);
              if (!scale) return [];
              const last = lastByScale.get(row.scaleId) ?? null;
              const state = scheduleStatus(row, last, now);
              return [
                {
                  scaleId: row.scaleId,
                  title: scale.definition.title,
                  intervalDays: row.intervalDays,
                  windowDays: row.windowDays,
                  active: row.active,
                  status: state.status,
                  dueAt: state.dueAt.toISOString(),
                  lastAnsweredAt: last ? last.toISOString() : null,
                },
              ];
            })
            .sort((a, b) => a.title.localeCompare(b.title, 'ru')),
          history: history.flatMap((row) => {
            const scale = this.catalog.scales.get(row.scaleId);
            if (!scale) return [];
            return [
              {
                responseId: row.responseId,
                scaleId: row.scaleId,
                scaleTitle: scale.definition.title,
                score: row.score,
                maxScore: row.maxScore,
                bandLabel: row.bandLabel,
                safetySignal: row.safetySignal,
                answeredAt: row.effectiveAt.toISOString(),
              },
            ];
          }),
        };
      },
      patientId,
    );
  }

  /** Patient answers an assigned scale. Scoring happens here, never on the client. */
  async submit(
    user: Principal,
    patientId: string,
    scaleId: string,
    submission: ScaleSubmission,
  ): Promise<ScaleResult> {
    return authorized(
      this.db,
      user,
      async (tx: Transaction) => {
        await assertCanAccessPatient(user, patientId, tx);
        assertRole(user, 'patient');
        const scale = this.requireScale(scaleId);
        // A retry of an already stored fill returns the stored result instead of a duplicate.
        // The patient lock taken by authorized() serializes concurrent retries.
        const [stored] = await tx
          .select({ response: questionnaireResponses, observation: observations })
          .from(questionnaireResponses)
          .innerJoin(observations, eq(observations.responseId, questionnaireResponses.id))
          .where(
            and(
              eq(questionnaireResponses.patientId, patientId),
              eq(questionnaireResponses.submissionId, submission.submissionId),
            ),
          );
        if (stored) {
          if (stored.response.scaleId !== scaleId)
            throw new DomainError(
              409,
              'submission_conflict',
              'Этот ответ уже сохранён для другой шкалы',
            );
          return {
            responseId: stored.response.id,
            scaleId,
            score: stored.observation.score,
            maxScore: stored.observation.maxScore,
            bandLabel: stored.observation.bandLabel,
            safetySignal: stored.observation.safetySignal,
            answeredAt: stored.observation.effectiveAt.toISOString(),
          };
        }
        const [schedule] = await tx
          .select()
          .from(scaleSchedules)
          .where(and(eq(scaleSchedules.patientId, patientId), eq(scaleSchedules.scaleId, scaleId)));
        if (!schedule?.active)
          throw new DomainError(409, 'scale_not_assigned', 'Шкала не назначена врачом');
        validateSubmission(scale.file, submission);
        const result = scoreScale(scale.file, submission.answers);
        const answeredAt = this.now();
        const [response] = await tx
          .insert(questionnaireResponses)
          .values({
            patientId,
            submissionId: submission.submissionId,
            scaleId,
            scaleVersion: scale.file.passport.version,
            answers: submission.answers,
            functionalAnswer: submission.functionalAnswer,
            answeredAt,
          })
          .returning({ id: questionnaireResponses.id });
        if (!response) throw new Error('Response insert failed');
        await tx.insert(observations).values({
          responseId: response.id,
          patientId,
          scaleId,
          score: result.score,
          maxScore: result.maxScore,
          bandLabel: result.bandLabel,
          safetySignal: result.safetySignal,
          effectiveAt: answeredAt,
        });
        // Clinical rules see the score in the same transaction as the answer (FR-4.5).
        await this.cards?.evaluate(tx, patientId, user.id, answeredAt, scaleId);
        await appendAudit(
          tx,
          {
            action: 'scale.answered',
            actorId: user.id,
            resourceId: patientId,
            detail: scaleId,
          },
          answeredAt,
        );
        return {
          responseId: response.id,
          scaleId,
          score: result.score,
          maxScore: result.maxScore,
          bandLabel: result.bandLabel,
          safetySignal: result.safetySignal,
          answeredAt: answeredAt.toISOString(),
        };
      },
      patientId,
    );
  }

  /** Doctor sets the schedule (FR-3.4). Admin has no clinical access, so it is denied here too. */
  async setSchedule(
    user: Principal,
    patientId: string,
    scaleId: string,
    input: ScaleScheduleInput,
  ): Promise<{ ok: true }> {
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx);
        assertRole(user, 'doctor');
        this.requireScale(scaleId);
        const now = this.now();
        await tx
          .insert(scaleSchedules)
          .values({
            patientId,
            scaleId,
            intervalDays: input.intervalDays,
            windowDays: input.windowDays,
            active: input.active,
            startsAt: now,
            updatedAt: now,
            updatedBy: user.id,
          })
          .onConflictDoUpdate({
            target: [scaleSchedules.patientId, scaleSchedules.scaleId],
            set: {
              intervalDays: input.intervalDays,
              windowDays: input.windowDays,
              active: input.active,
              updatedAt: now,
              updatedBy: user.id,
            },
          });
        await appendAudit(
          tx,
          {
            action: 'scale.schedule_changed',
            actorId: user.id,
            resourceId: patientId,
            detail: scaleId,
          },
          now,
        );
        return { ok: true as const };
      },
      patientId,
    );
  }
}
