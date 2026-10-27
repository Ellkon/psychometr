#!/usr/bin/env node
// Refresh content/icd10/mkb10.json from the НСИ Минздрава export of МКБ-10.
// Usage: pnpm import:icd10 [path/to/<oid>_<version>_json.zip]
// Without a path the current version is downloaded from nsi.rosminzdrav.ru (developer machine
// only: the API never calls external services, it reads the committed snapshot).
// НСИ uses a certificate of the Russian Trusted Root CA (Минцифры), which is not in the public
// trust stores. The root is committed in scripts/certs and pinned by fingerprint below; TLS
// verification stays on and trusts only this root for the НСИ host.
/* eslint-disable security/detect-non-literal-fs-filename -- paths come from the operator's CLI argument and the repo layout. */
import { X509Certificate } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from './grls.mjs';
import { ICD10_OID, selectIcd10 } from './icd10.mjs';

const NSI = 'https://nsi.rosminzdrav.ru';
/** SHA-256 of Russian Trusted Root CA as published on gosuslugi.ru (valid until 2032-02-27). */
const ROOT_FINGERPRINT =
  'D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'content', 'icd10', 'mkb10.json');

async function trustedRoot() {
  const pem = await readFile(path.join(root, 'scripts', 'certs', 'russian-trusted-root-ca.crt'));
  if (new X509Certificate(pem).fingerprint256 !== ROOT_FINGERPRINT)
    throw new Error('scripts/certs/russian-trusted-root-ca.crt does not match the pinned root');
  return pem;
}

function download(url, ca) {
  return new Promise((resolve, reject) => {
    get(url, { ca, timeout: 120_000 }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`НСИ ${new URL(url).pathname}: HTTP ${String(response.statusCode)}`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
      response.on('error', reject);
    })
      .on('timeout', function () {
        this.destroy(new Error('НСИ request timed out'));
      })
      .on('error', reject);
  });
}

async function fetchExport() {
  const ca = await trustedRoot();
  const json = async (pathname) => JSON.parse((await download(`${NSI}${pathname}`, ca)).toString());
  const passport = await json(`/api/passport?identifier=${ICD10_OID}`);
  if (passport.oid !== ICD10_OID || typeof passport.version !== 'string')
    throw new Error('Unexpected НСИ passport');
  const [fileName] = await json(
    `/api/dataFiles?identifier=${ICD10_OID}&version=${encodeURIComponent(passport.version)}&format=JSON`,
  );
  if (typeof fileName !== 'string' || !/^[\w.]+_json\.zip$/.test(fileName))
    throw new Error('Unexpected НСИ export file name');
  return download(`${NSI}/api/dataFiles/${fileName}`, ca);
}

const archivePath = process.argv[2];
const archive = archivePath ? await readFile(path.resolve(archivePath)) : await fetchExport();
const members = readZip(archive);
const jsonName = [...members.keys()].find((name) => name.endsWith('.json'));
// The member is named <oid>_<version>.json whatever the archive is called.
const version = jsonName?.startsWith(`${ICD10_OID}_`)
  ? /_([\d.]+)\.json$/.exec(jsonName)?.[1]
  : undefined;
if (!jsonName || !version) throw new Error('No МКБ-10 JSON file in the НСИ archive');
const records = JSON.parse(members.get(jsonName)().toString('utf8')).records;
if (!Array.isArray(records)) throw new Error('Unexpected НСИ export format');

const entries = selectIcd10(records);
if (entries.length < 10_000)
  throw new Error(
    `Only ${String(entries.length)} codes selected; the export format may have changed`,
  );

const header = {
  id: 'mkb10',
  source_id: 'mkb10',
  version,
  selection:
    'Все действующие (ACTUAL = 1) рубрики и подрубрики МКБ-10 с кодом; классы и блоки (заголовки) не включены.',
};
// One entry per line: a refresh shows up in review as a readable line diff.
const head = JSON.stringify(header, null, 2).replace(/\n}$/, ',\n  "entries": [\n');
const lines = entries.map(
  (entry) => `    { "code": ${JSON.stringify(entry.code)}, "name": ${JSON.stringify(entry.name)} }`,
);
await writeFile(target, `${head}${lines.join(',\n')}\n  ]\n}\n`);
console.log(
  `МКБ-10 НСИ ${version}: ${String(entries.length)} codes → ${path.relative(root, target)}`,
);
