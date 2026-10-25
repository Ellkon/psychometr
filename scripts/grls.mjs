// Read the public ГРЛС registry export (ZIP of XLSX sheets) without extra dependencies.
// Only the parts this project needs: ZIP central directory, deflate, shared strings, one sheet.
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Returns the members of a ZIP archive as name → lazy content reader. */
export function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const members = new Map();
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error('Broken ZIP directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    // ГРЛС writes UTF-8 names without setting the UTF-8 flag; decode as UTF-8 regardless.
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    members.set(name, () => {
      if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error('Broken ZIP entry');
      const start =
        localOffset +
        30 +
        buffer.readUInt16LE(localOffset + 26) +
        buffer.readUInt16LE(localOffset + 28);
      const data = buffer.subarray(start, start + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`Unsupported ZIP method ${method}`);
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return members;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodes XML entities and the OOXML `_xHHHH_` escapes. */
export function decodeXmlText(text) {
  return text
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (code[0] === '#')
        return String.fromCodePoint(
          code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1)),
        );
      return ENTITIES[code] ?? match;
    })
    .replace(/_x([0-9a-f]{4})_/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function textRuns(xml) {
  let out = '';
  for (const match of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += match[1];
  return decodeXmlText(out);
}

/** Rows of the first worksheet as objects keyed by column letter. */
export function readFirstSheet(xlsxBuffer) {
  const members = readZip(xlsxBuffer);
  const sharedXml = members.get('xl/sharedStrings.xml')?.().toString('utf8') ?? '';
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    textRuns(match[1]),
  );
  const sheetName = [...members.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort()[0];
  if (!sheetName) throw new Error('No worksheet in XLSX');
  const sheet = members.get(sheetName)().toString('utf8');
  const rows = [];
  for (const rowMatch of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = {};
    for (const cell of rowMatch[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cell[1];
      const column = /\br="([A-Z]+)\d+"/.exec(attributes)?.[1];
      if (!column) continue;
      const type = /\bt="([a-zA-Z]+)"/.exec(attributes)?.[1];
      const body = cell[2] ?? '';
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      if (type === 's' && value !== undefined) row[column] = shared[Number(value)] ?? '';
      else if (type === 'inlineStr') row[column] = textRuns(body);
      else row[column] = value === undefined ? '' : decodeXmlText(value);
    }
    rows.push(row);
  }
  return rows;
}

/** "31.05.2023" → "2023-05-31"; anything else → null. */
export function isoDate(value) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec((value ?? '').trim());
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

/** Dosage form with strength, without packaging: "таблетки, покрытые …, 50 мг". */
export function dosageForms(cell) {
  const forms = new Set();
  for (const part of (cell ?? '').split(/;\s*|\r?\n/)) {
    const form = part
      .split(/\s+-\s+/)[0]
      .replace(/,\s*\d+\s*шт\..*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    // Pharmaceutical substances are raw material for manufacturers, not prescribable products.
    if (form && !/^без рецепта$|^по рецепту$|^субстанция/i.test(form)) forms.add(form);
  }
  return [...forms].sort((a, b) => a.localeCompare(b, 'ru'));
}

const PSYCHOTROPIC_GROUP = /антидепрессант|анксиолит/i;

/**
 * Active registrations of every INN that ГРЛС lists in an antidepressant or anxiolytic
 * pharmacotherapeutic group. Rows without a group are kept when their INN qualifies.
 * Columns follow the "Действующий" sheet: C number, D date, E expiry, F cancellation,
 * G holder, I trade name, J INN, K release forms, N group.
 */
export function selectPsychotropics(rows, today) {
  // Data rows carry a registration number and a registration date; titles and headers do not.
  const data = rows.filter((row) => (row.C ?? '').trim() && isoDate(row.D));
  const inns = new Set(
    data
      .filter((row) => PSYCHOTROPIC_GROUP.test(row.N ?? ''))
      .map((row) => (row.J ?? '').trim())
      .filter((inn) => inn && inn !== '~'),
  );
  const products = [];
  for (const row of data) {
    const inn = (row.J ?? '').trim();
    if (!inns.has(inn) || (row.F ?? '').trim()) continue;
    const expires = isoDate(row.E);
    if (expires && expires < today) continue;
    const forms = dosageForms(row.K);
    if (forms.length === 0) continue;
    products.push({
      reg_number: row.C.trim(),
      trade_name: (row.I ?? '').trim(),
      inn,
      dosage_forms: forms,
      holder: (row.G ?? '').trim(),
      registered_on: isoDate(row.D),
    });
  }
  return products.sort(
    (a, b) =>
      a.inn.localeCompare(b.inn, 'ru') ||
      a.trade_name.localeCompare(b.trade_name, 'ru') ||
      a.reg_number.localeCompare(b.reg_number),
  );
}
