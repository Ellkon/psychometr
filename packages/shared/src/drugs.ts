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

/**
 * Products the prescription form lists first (content/drugs/featured.json). Display order only,
 * not a recommendation: the doctor chooses the drug and the dose.
 */
export const DrugFeaturedFileSchema = z
  .object({
    note: z.string().min(1),
    reg_numbers: z.array(z.string().min(1).max(100)).max(20),
  })
  .strict();
export type DrugFeaturedFile = z.infer<typeof DrugFeaturedFileSchema>;

/** Doctor-facing catalog entry: what the prescription form offers for selection. */
export const DrugOptionSchema = z.object({
  regNumber: z.string(),
  tradeName: z.string(),
  inn: z.string(),
  dosageForms: z.array(z.string()),
  /** Listed first in the prescription form (featured.json). */
  featured: z.boolean(),
});
export const DrugCatalogSchema = z.object({
  exportDate: z.iso.date(),
  products: z.array(DrugOptionSchema),
});
export type DrugCatalog = z.infer<typeof DrugCatalogSchema>;
