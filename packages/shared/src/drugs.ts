import { z } from 'zod';

/** One registered medicinal product from the ГРЛС snapshot (content/drugs). */
export const DrugProductSchema = z
  .object({
    reg_number: z.string().min(1).max(100),
    trade_name: z.string().min(1).max(300),
    inn: z.string().min(1).max(300),
    dosage_forms: z.array(z.string().min(1).max(300)).min(1),
    holder: z.string().max(500),
    registered_on: z.iso.date().nullable(),
  })
  .strict();
export type DrugProduct = z.infer<typeof DrugProductSchema>;

/** Snapshot of the public ГРЛС export; refreshed with `pnpm import:grls`. */
export const DrugCatalogFileSchema = z
  .object({
    id: z.literal('grls-psychotropics'),
    source_id: z.literal('grls'),
    export_date: z.iso.date(),
    selection: z.string().min(1),
    products: z.array(DrugProductSchema).min(1),
  })
  .strict();
export type DrugCatalogFile = z.infer<typeof DrugCatalogFileSchema>;

/** Doctor-facing catalog entry: what the prescription form offers for selection. */
export const DrugOptionSchema = z.object({
  regNumber: z.string(),
  tradeName: z.string(),
  inn: z.string(),
  dosageForms: z.array(z.string()),
});
export const DrugCatalogSchema = z.object({
  exportDate: z.iso.date(),
  products: z.array(DrugOptionSchema),
});
export type DrugCatalog = z.infer<typeof DrugCatalogSchema>;
