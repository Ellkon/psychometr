#!/usr/bin/env node
/**
 * Validates content/*.json against the shared zod schemas.
 * Run in CI and locally: `pnpm check:content`.
 *
 * This is the enforcement of NFR-6: content is data, and broken data must not
 * reach the engine. When scale/rule schemas land in packages/shared, register
 * them in VALIDATORS below.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DrugCatalogFileSchema,
  DrugFeaturedFileSchema,
  EmergencyFileSchema,
  RuleFileSchema,
  ScaleFileSchema,
  SourcesFileSchema,
} from '@psychometr/shared';

const contentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'content');

/** File name (relative to content/) -> zod schema. Extend as content grows. */
const VALIDATORS = {
  'sources.json': SourcesFileSchema,
  'scales/phq9.ru.json': ScaleFileSchema,
  'scales/gad7.ru.json': ScaleFileSchema,
  'rules/routing.json': RuleFileSchema,
  'rules/adherence.json': RuleFileSchema,
  'rules/safety.json': RuleFileSchema,
  'emergency/patient.ru.json': EmergencyFileSchema,
  'drugs/grls-psychotropics.json': DrugCatalogFileSchema,
  'drugs/featured.json': DrugFeaturedFileSchema,
};

let failed = false;

const entries = await readdir(contentDir, { withFileTypes: true });

for (const [fileName, schema] of Object.entries(VALIDATORS)) {
  try {
    const raw = await readFile(path.join(contentDir, fileName), 'utf8');
    const data = JSON.parse(raw);
    schema.parse(data);
    console.log(`ok: content/${fileName}`);
  } catch (error) {
    failed = true;
    console.error('FAIL: content/%s: %s', fileName, error instanceof Error ? error.message : error);
  }
}

// Every scale must cite only registered sources (AGENTS.md: no source, no rule/scale).
try {
  const sources = new Set(
    JSON.parse(await readFile(path.join(contentDir, 'sources.json'), 'utf8')).sources.map(
      (source) => source.id,
    ),
  );
  for (const fileName of Object.keys(VALIDATORS).filter((name) => name.startsWith('scales/'))) {
    const scale = JSON.parse(await readFile(path.join(contentDir, fileName), 'utf8'));
    const { passport } = scale;
    const cited = [...passport.source_ids, passport.text_source_id, passport.license_source_id];
    for (const id of cited) {
      if (!sources.has(id)) {
        failed = true;
        console.error('FAIL: content/%s cites unknown source "%s"', fileName, id);
      }
    }
  }
} catch (error) {
  failed = true;
  console.error('FAIL: source references: %s', error instanceof Error ? error.message : error);
}

// Every rule must cite a registered source, and no rule file may skip validation (FR-4.1, AGENTS.md).
try {
  const sources = new Set(
    JSON.parse(await readFile(path.join(contentDir, 'sources.json'), 'utf8')).sources.map(
      (source) => source.id,
    ),
  );
  const ruleIds = new Set();
  for (const fileName of Object.keys(VALIDATORS).filter((name) => name.startsWith('rules/'))) {
    const file = RuleFileSchema.parse(
      JSON.parse(await readFile(path.join(contentDir, fileName), 'utf8')),
    );
    for (const rule of file.rules) {
      if (ruleIds.has(rule.id)) {
        failed = true;
        console.error('FAIL: duplicate rule id "%s" in content/%s', rule.id, fileName);
      }
      ruleIds.add(rule.id);
      if (!sources.has(rule.source_id)) {
        failed = true;
        console.error(
          'FAIL: content/%s rule "%s" cites unknown source "%s"',
          fileName,
          rule.id,
          rule.source_id,
        );
      }
    }
  }
} catch (error) {
  failed = true;
  console.error('FAIL: rule references: %s', error instanceof Error ? error.message : error);
}

// Featured products must exist in the ГРЛС snapshot.
try {
  const known = new Set(
    JSON.parse(
      await readFile(path.join(contentDir, 'drugs', 'grls-psychotropics.json'), 'utf8'),
    ).products.map((product) => product.reg_number),
  );
  const featured = JSON.parse(await readFile(path.join(contentDir, 'drugs', 'featured.json'), 'utf8'));
  for (const regNumber of featured.reg_numbers) {
    if (!known.has(regNumber)) {
      failed = true;
      console.error('FAIL: content/drugs/featured.json: %s is not in the snapshot', regNumber);
    }
  }
} catch (error) {
  failed = true;
  console.error('FAIL: featured drugs: %s', error instanceof Error ? error.message : error);
}

// Emergency lines may wait for a confirmed source, but never cite an unknown one.
try {
  const sources = new Set(
    JSON.parse(await readFile(path.join(contentDir, 'sources.json'), 'utf8')).sources.map(
      (source) => source.id,
    ),
  );
  const file = EmergencyFileSchema.parse(
    JSON.parse(await readFile(path.join(contentDir, 'emergency/patient.ru.json'), 'utf8')),
  );
  for (const line of file.lines) {
    if (line.source_id === null) {
      console.log('warn: content/emergency/patient.ru.json line without source: "%s"', line.text);
    } else if (!sources.has(line.source_id)) {
      failed = true;
      console.error(
        'FAIL: content/emergency/patient.ru.json cites unknown source "%s"',
        line.source_id,
      );
    }
  }
} catch (error) {
  failed = true;
  console.error('FAIL: emergency references: %s', error instanceof Error ? error.message : error);
}

for (const entry of entries) {
  if (entry.isFile() && entry.name.endsWith('.json') && !(entry.name in VALIDATORS)) {
    console.log(`warn: content/${entry.name} has no registered schema yet`);
  }
}

// An unregistered rule file would bypass validation entirely; fail instead of warning.
for (const name of await readdir(path.join(contentDir, 'rules'))) {
  if (name.endsWith('.json') && !(`rules/${name}` in VALIDATORS)) {
    failed = true;
    console.error('FAIL: content/rules/%s is not registered in VALIDATORS', name);
  }
}

if (failed) {
  process.exit(1);
}
