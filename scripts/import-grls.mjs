#!/usr/bin/env node
// Refresh content/drugs/grls-psychotropics.json from the public ГРЛС export.
// Usage: pnpm import:grls [path/to/grls.zip]
// Without a path the current export is downloaded from grls.rosminzdrav.ru (developer machine
// only: the API never calls external services, it reads the committed snapshot).
/* eslint-disable security/detect-non-literal-fs-filename -- paths come from the operator's CLI argument and the repo layout. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFirstSheet, readZip, selectPsychotropics } from './grls.mjs';

const GRLS_PAGE = 'https://grls.rosminzdrav.ru/GRLS.aspx';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'content', 'drugs', 'grls-psychotropics.json');

async function download() {
  const page = await (await fetch(GRLS_PAGE)).text();
  const link = /GetGRLS\.ashx\?FileGUID=[0-9a-f-]{36}&(?:amp;)?UserReq=\d+/i.exec(page)?.[0];
  if (!link) throw new Error('Download link not found on the ГРЛС page');
  const response = await fetch(new URL(link.replace('&amp;', '&'), GRLS_PAGE));
  if (!response.ok) throw new Error(`ГРЛС download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const archivePath = process.argv[2];
const archive = archivePath ? await readFile(path.resolve(archivePath)) : await download();
const members = readZip(archive);
const activeName = [...members.keys()].find((name) => /Действующий\.xlsx$/.test(name));
if (!activeName) throw new Error('Sheet "Действующий" not found in the ГРЛС archive');
const exportDate = /grls(\d{4}-\d{2}-\d{2})/.exec(activeName)?.[1];
if (!exportDate) throw new Error(`Unexpected ГРЛС file name: ${activeName}`);

const products = selectPsychotropics(readFirstSheet(members.get(activeName)()), exportDate);
if (products.length === 0)
  throw new Error('No products selected; the export format may have changed');

const snapshot = {
  id: 'grls-psychotropics',
  source_id: 'grls',
  export_date: exportDate,
  selection:
    'Действующие регистрации всех МНН, у которых в ГРЛС есть фармакотерапевтическая группа «антидепрессант» или «анксиолитик».',
  products,
};
await writeFile(target, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(
  `ГРЛС ${exportDate}: ${products.length} products, ${new Set(products.map((p) => p.inn)).size} INN → ${path.relative(root, target)}`,
);
