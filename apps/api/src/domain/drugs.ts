/* eslint-disable security/detect-non-literal-fs-filename -- Content directory is deployment-only; the file name is a constant. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DrugCatalogFileSchema, type DrugCatalog, type DrugProduct } from '@psychometr/shared';

/** ГРЛС snapshot from content/drugs; refreshed offline with `pnpm import:grls`. */
export interface DrugRegistry {
  readonly catalog: DrugCatalog;
  readonly byRegNumber: ReadonlyMap<string, DrugProduct>;
}

export async function loadDrugRegistry(contentDir: string): Promise<DrugRegistry> {
  const file = DrugCatalogFileSchema.parse(
    JSON.parse(await readFile(path.join(contentDir, 'drugs', 'grls-psychotropics.json'), 'utf8')),
  );
  return {
    catalog: {
      exportDate: file.export_date,
      products: file.products.map((product) => ({
        regNumber: product.reg_number,
        tradeName: product.trade_name,
        inn: product.inn,
        dosageForms: product.dosage_forms,
      })),
    },
    byRegNumber: new Map(file.products.map((product) => [product.reg_number, product])),
  };
}
