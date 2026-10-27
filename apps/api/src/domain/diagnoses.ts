/* eslint-disable security/detect-non-literal-fs-filename -- Content directory is deployment-only; the file name is a constant. */
/**
 * Diagnoses in the patient's card (FR-7.4). The doctor records them; the ICD-10 catalog from
 * content/icd10 only completes the input. The system never derives a diagnosis from scores.
 * Doctors of the care team only: the patient's own view is out of scope.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  ICD10_SEARCH_LIMIT,
  Icd10FileSchema,
  type DiagnosisInput,
  type Icd10Entry,
  type Icd10SearchResult,
  type PatientDiagnoses,
  type Principal,
} from '@psychometr/shared';
import type { Database } from '../db/client.js';
import { diagnoses } from '../db/schema.js';
import { assertCanAccessPatient, assertRole, authorized } from './access.js';
import { appendAudit } from './audit.js';
import { DomainError } from './errors.js';

const LIST_LIMIT = 100;

/** НСИ snapshot of МКБ-10 from content/icd10, refreshed offline with `pnpm import:icd10`. */
export interface Icd10Catalog {
  readonly version: string;
  readonly entries: readonly Icd10Entry[];
  readonly byCode: ReadonlyMap<string, string>;
  /** Entries with lower-case names, ё folded to е, for word search. */
  readonly searchable: readonly { readonly entry: Icd10Entry; readonly name: string }[];
}

const fold = (value: string) => value.toLowerCase().replaceAll('ё', 'е');
const CODE_PREFIX = /^[a-z][0-9]{0,2}(\.[0-9]{0,2})?$/i;

export async function loadIcd10Catalog(contentDir: string): Promise<Icd10Catalog> {
  const file = Icd10FileSchema.parse(
    JSON.parse(await readFile(path.join(contentDir, 'icd10', 'mkb10.json'), 'utf8')),
  );
  return {
    version: file.version,
    entries: file.entries,
    byCode: new Map(file.entries.map((entry) => [entry.code, entry.name])),
    searchable: file.entries.map((entry) => ({ entry, name: fold(entry.name) })),
  };
}

/**
 * A code prefix ("f41.") lists the codes under it. Otherwise every word must occur in the name;
 * names starting with the first word come first, then catalog (code) order.
 */
export function searchIcd10(catalog: Icd10Catalog, query: string): Icd10Entry[] {
  const q = query.trim();
  if (CODE_PREFIX.test(q)) {
    const prefix = q.toUpperCase();
    return catalog.entries
      .filter((entry) => entry.code.startsWith(prefix))
      .slice(0, ICD10_SEARCH_LIMIT);
  }
  const words = fold(q).split(/\s+/).filter(Boolean);
  const [first = ''] = words;
  const leading: Icd10Entry[] = [];
  const other: Icd10Entry[] = [];
  for (const { entry, name } of catalog.searchable) {
    if (!words.every((word) => name.includes(word))) continue;
    (name.startsWith(first) ? leading : other).push(entry);
  }
  return [...leading, ...other].slice(0, ICD10_SEARCH_LIMIT);
}

export class DiagnosisService {
  constructor(
    private readonly db: Database,
    private readonly icd10: Icd10Catalog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Reference data, no patient data; doctors only. */
  searchIcd10(user: Principal, query: string): Icd10SearchResult {
    assertRole(user, 'doctor');
    return { version: this.icd10.version, entries: searchIcd10(this.icd10, query) };
  }

  async add(user: Principal, patientId: string, input: DiagnosisInput): Promise<{ id: string }> {
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx);
        assertRole(user, 'doctor');
        if (input.code !== null && !this.icd10.byCode.has(input.code))
          throw new DomainError(400, 'unknown_icd10', `Кода ${input.code} нет в МКБ-10`);
        const [stored] = await tx
          .select({ id: diagnoses.id, patientId: diagnoses.patientId })
          .from(diagnoses)
          .where(
            and(
              eq(diagnoses.practitionerId, user.id),
              eq(diagnoses.submissionId, input.submissionId),
            ),
          );
        if (stored) {
          if (stored.patientId !== patientId)
            throw new DomainError(409, 'submission_reused', 'Повторите отправку формы');
          return { id: stored.id };
        }
        const now = this.now();
        const [row] = await tx
          .insert(diagnoses)
          .values({
            patientId,
            practitionerId: user.id,
            submissionId: input.submissionId,
            code: input.code,
            text: input.text,
            createdAt: now,
          })
          .returning({ id: diagnoses.id });
        if (!row) throw new Error('Diagnosis insert failed');
        await appendAudit(
          tx,
          { action: 'diagnosis.added', actorId: user.id, resourceId: patientId },
          now,
        );
        return { id: row.id };
      },
      patientId,
    );
  }

  async remove(user: Principal, patientId: string, diagnosisId: string) {
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx);
        assertRole(user, 'doctor');
        const now = this.now();
        const [updated] = await tx
          .update(diagnoses)
          .set({ removedAt: now, removedBy: user.id })
          .where(
            and(
              eq(diagnoses.id, diagnosisId),
              eq(diagnoses.patientId, patientId),
              isNull(diagnoses.removedAt),
            ),
          )
          .returning({ id: diagnoses.id });
        if (!updated) {
          const [row] = await tx
            .select({ id: diagnoses.id })
            .from(diagnoses)
            .where(and(eq(diagnoses.id, diagnosisId), eq(diagnoses.patientId, patientId)));
          if (!row) throw new DomainError(404, 'diagnosis_not_found', 'Диагноз не найден');
          throw new DomainError(409, 'diagnosis_removed', 'Диагноз уже снят');
        }
        await appendAudit(
          tx,
          { action: 'diagnosis.removed', actorId: user.id, resourceId: patientId },
          now,
        );
        return { ok: true as const };
      },
      patientId,
    );
  }

  /** Current diagnoses first, then removed ones, newest first within each group. */
  async list(user: Principal, patientId: string): Promise<PatientDiagnoses> {
    return authorized(
      this.db,
      user,
      async (tx) => {
        await assertCanAccessPatient(user, patientId, tx);
        assertRole(user, 'doctor');
        const rows = await tx
          .select()
          .from(diagnoses)
          .where(eq(diagnoses.patientId, patientId))
          .orderBy(desc(diagnoses.createdAt))
          .limit(LIST_LIMIT);
        await appendAudit(
          tx,
          { action: 'diagnoses.viewed', actorId: user.id, resourceId: patientId },
          this.now(),
        );
        const view = rows.map((row) => ({
          id: row.id,
          code: row.code,
          text: row.text,
          createdAt: row.createdAt.toISOString(),
          removedAt: row.removedAt?.toISOString() ?? null,
        }));
        return {
          diagnoses: [
            ...view.filter((row) => row.removedAt === null),
            ...view.filter((row) => row.removedAt !== null),
          ],
        };
      },
      patientId,
    );
  }
}
