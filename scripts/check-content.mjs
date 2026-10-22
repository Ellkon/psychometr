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

import { SourcesFileSchema } from '@psychometr/shared';

const contentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'content');

/** File name (relative to content/) -> zod schema. Extend as content grows. */
const VALIDATORS = {
  'sources.json': SourcesFileSchema,
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

for (const entry of entries) {
  if (entry.isFile() && entry.name.endsWith('.json') && !(entry.name in VALIDATORS)) {
    console.log(`warn: content/${entry.name} has no registered schema yet`);
  }
}

if (failed) {
  process.exit(1);
}
