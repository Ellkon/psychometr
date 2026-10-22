/**
 * Registry of clinical sources (clinical guidelines, GRLS, validation papers).
 * Every rule in content/rules must reference an entry here (see AGENTS.md).
 */
import { z } from 'zod';

/** Kinds of sources a rule may cite. */
export const SourceKindSchema = z.enum([
  'clinical_guideline', // КР (клинические рекомендации)
  'grls', // ГРЛС (drug instructions)
  'validation_study', // psychometric validation publications
  'regulation', // laws and regulatory acts
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const SourceSchema = z.object({
  id: z.string().min(1),
  kind: SourceKindSchema,
  title: z.string().min(1),
  /** Free-form citation details: document number, edition date, thesis number. */
  citation: z.string().min(1),
  /** Optional external reference (documented as text; the app never fetches it). */
  url: z.url().optional(),
});
export type Source = z.infer<typeof SourceSchema>;

export const SourcesFileSchema = z.object({
  sources: z.array(SourceSchema),
});
export type SourcesFile = z.infer<typeof SourcesFileSchema>;
