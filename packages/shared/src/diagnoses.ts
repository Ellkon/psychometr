import { z } from 'zod';
import { IdSchema } from './access.js';

/**
 * Diagnoses the doctor records in the patient's card (FR-7.4). The system never suggests a
 * diagnosis: the ICD-10 catalog only completes what the doctor types. A diagnosis is never
 * edited; the doctor removes it and records a new one, both kept for the audit trail.
 */

/** ICD-10 code: a category (F32) or a subcategory (F32.1, F32.10). */
export const Icd10CodeSchema = z.string().regex(/^[A-Z][0-9]{2}(\.[0-9]{1,2})?$/);
export const DIAGNOSIS_TEXT_MAX = 300;

/** One ICD-10 entry of the content/icd10 catalog. */
export const Icd10EntrySchema = z
  .object({ code: Icd10CodeSchema, name: z.string().min(1).max(500) })
  .strict();
export type Icd10Entry = z.infer<typeof Icd10EntrySchema>;

/** НСИ Минздрава snapshot of МКБ-10 (OID 1.2.643.5.1.13.13.11.1005); `pnpm import:icd10`. */
export const Icd10FileSchema = z
  .object({
    id: z.literal('mkb10'),
    source_id: z.literal('mkb10'),
    /** Version of the НСИ classifier the snapshot was taken from. */
    version: z.string().regex(/^\d+(\.\d+)*$/),
    selection: z.string().min(1),
    entries: z.array(Icd10EntrySchema).min(1),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const entry of file.entries) {
      if (seen.has(entry.code))
        ctx.addIssue({ code: 'custom', message: `Duplicate ICD-10 code ${entry.code}` });
      seen.add(entry.code);
    }
  });
export type Icd10File = z.infer<typeof Icd10FileSchema>;

export const ICD10_SEARCH_LIMIT = 20;
/** Code prefix ("f41", "F41.1") or words of the name ("генерализ тревож"). */
export const Icd10SearchQuerySchema = z.object({ q: z.string().trim().min(1).max(100) }).strict();

export const Icd10SearchResultSchema = z
  .object({
    version: z.string(),
    entries: z.array(Icd10EntrySchema).max(ICD10_SEARCH_LIMIT),
  })
  .strict();
export type Icd10SearchResult = z.infer<typeof Icd10SearchResultSchema>;

export const DiagnosisInputSchema = z
  .object({
    /** Client-generated per form fill: a retried send stores one diagnosis. */
    submissionId: IdSchema,
    code: Icd10CodeSchema.nullable(),
    text: z.string().trim().min(1).max(DIAGNOSIS_TEXT_MAX),
  })
  .strict();
export type DiagnosisInput = z.infer<typeof DiagnosisInputSchema>;

export const DiagnosisParamsSchema = z
  .object({ patientId: IdSchema, diagnosisId: IdSchema })
  .strict();

export const DiagnosisSchema = z
  .object({
    id: IdSchema,
    code: Icd10CodeSchema.nullable(),
    text: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    removedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

export const PatientDiagnosesSchema = z.object({ diagnoses: z.array(DiagnosisSchema) }).strict();
export type PatientDiagnoses = z.infer<typeof PatientDiagnosesSchema>;

/**
 * Splits the doctor's entry into an ICD-10 code and text. "F32.1 Депрессивный эпизод" (as the
 * catalog suggests it) and "f32.1 ..." give the code; anything else is free text without a code.
 */
export function parseDiagnosisEntry(value: string): { code: string | null; text: string } {
  const entry = value.trim().replace(/\s+/g, ' ');
  const match = /^([A-Za-z][0-9]{2}(?:\.[0-9]{1,2})?)(?:\s+(.*))?$/.exec(entry);
  if (!match?.[1]) return { code: null, text: entry };
  const code = match[1].toUpperCase();
  return { code, text: match[2]?.trim() || code };
}
