/* eslint-disable security/detect-non-literal-fs-filename -- Content directory is deployment-only; the file name is a constant. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DrugCatalogFileSchema,
  DrugFeaturedFileSchema,
  type DrugCatalog,
  type DrugProduct,
} from '@psychometr/shared';

/** ГРЛС snapshot from content/drugs; refreshed offline with `pnpm import:grls`. */
export interface DrugRegistry {
  readonly catalog: DrugCatalog;
  readonly byRegNumber: ReadonlyMap<string, DrugProduct>;
}

export async function loadDrugRegistry(contentDir: string): Promise<DrugRegistry> {
  const file = DrugCatalogFileSchema.parse(
    JSON.parse(await readFile(path.join(contentDir, 'drugs', 'grls-psychotropics.json'), 'utf8')),
  );
  const featured = new Set(
    DrugFeaturedFileSchema.parse(
      JSON.parse(await readFile(path.join(contentDir, 'drugs', 'featured.json'), 'utf8')),
    ).reg_numbers,
  );
  const known = new Set(file.products.map((product) => product.reg_number));
  for (const regNumber of featured)
    if (!known.has(regNumber))
      throw new Error(`featured.json: ${regNumber} is not in the snapshot`);
  const products = file.products.map((product) => ({
    regNumber: product.reg_number,
    tradeName: product.trade_name,
    inn: product.inn,
    dosageForms: product.dosage_forms,
    featured: featured.has(product.reg_number),
  }));
  return {
    catalog: {
      exportDate: file.export_date,
      // Featured first; the snapshot order is kept otherwise (sort is stable).
      products: products.sort((a, b) => Number(b.featured) - Number(a.featured)),
    },
    byRegNumber: new Map(file.products.map((product) => [product.reg_number, product])),
  };
}
