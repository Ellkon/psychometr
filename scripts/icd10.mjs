// Selection of the МКБ-10 catalog from the НСИ Минздрава export (OID 1.2.643.5.1.13.13.11.1005).
// Pure functions: download and file handling live in import-icd10.mjs.

export const ICD10_OID = '1.2.643.5.1.13.13.11.1005';
const CODE = /^[A-Z][0-9]{2}(\.[0-9]{1,2})?$/;

/**
 * Codable rubrics only: chapters (I, II…) and blocks (A00-A09) are headings, not diagnoses.
 * Records the classifier marks as not current (ACTUAL ≠ 1) are left out.
 */
export function selectIcd10(records) {
  const entries = new Map();
  for (const record of records) {
    const code = String(record.MKB_CODE ?? '').trim();
    const name = String(record.MKB_NAME ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!CODE.test(code) || record.ACTUAL !== 1 || name === '') continue;
    if (entries.has(code)) throw new Error(`Duplicate current ICD-10 code ${code}`);
    entries.set(code, name);
  }
  return [...entries]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([code, name]) => ({ code, name }));
}
