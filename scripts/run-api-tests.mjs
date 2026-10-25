#!/usr/bin/env node
// embedded-postgres installs an exit hook which can mask Vitest's exit code.
// Fail closed on a missing/failed JSON report as well as the process status.
import { mkdir, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../apps/api/', import.meta.url));
const report = new URL('../apps/api/test-results/vitest.json', import.meta.url);
await mkdir(new URL('../apps/api/test-results/', import.meta.url), { recursive: true });
await rm(report, { force: true });
const child = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('../apps/api/node_modules/vitest/vitest.mjs', import.meta.url)),
    'run',
    '--reporter=default',
    '--reporter=json',
    '--outputFile=test-results/vitest.json',
  ],
  { cwd, stdio: 'inherit' },
);
try {
  const result = JSON.parse(await readFile(report, 'utf8'));
  if (
    child.status !== 0 ||
    !result.success ||
    result.numTotalTests < 1 ||
    result.numFailedTests !== 0 ||
    result.numPendingTests !== 0
  )
    process.exitCode = 1;
} catch {
  console.error('API test run did not produce a valid complete report.');
  process.exitCode = 1;
}
