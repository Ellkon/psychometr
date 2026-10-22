import assert from 'node:assert/strict';
import { test } from 'node:test';

import { annotationsFor } from './annotate-security.mjs';

test('gitleaks annotations omit matched values and escape workflow commands', () => {
  const [annotation] = annotationsFor('gitleaks', [
    {
      File: 'example,src.ts\n::warning::injected',
      StartLine: 2,
      RuleID: 'generic-api-key',
      Commit: 'test-commit',
      Secret: 'sensitive-fixture',
      Match: 'sensitive-fixture',
    },
  ]);
  assert.match(annotation, /file=example%2Csrc.ts%0A%3A%3Awarning%3A%3Ainjected,line=2/);
  assert.ok(!annotation.includes('sensitive-fixture'));
  assert.ok(!annotation.includes('\n'));
});

test('semgrep annotations contain the rule and location, never source or error text', () => {
  const annotations = annotationsFor('semgrep', {
    results: [
      {
        path: 'example.ts',
        start: { line: 7 },
        check_id: 'unsafe-formatstring',
        extra: { lines: 'sensitive-fixture' },
      },
    ],
    errors: [{ type: 'ScanError', message: 'sensitive-fixture' }],
  });
  assert.equal(annotations.length, 2);
  assert.match(annotations[0], /file=example.ts,line=7/);
  assert.match(annotations[0], /unsafe-formatstring/);
  assert.match(annotations[1], /ScanError/);
  assert.ok(!annotations.join('').includes('sensitive-fixture'));
});

test('trivy reports HIGH and CRITICAL including unfixed vulnerabilities', () => {
  const annotations = annotationsFor('trivy', {
    Results: [
      {
        Target: 'example.json',
        Vulnerabilities: [
          { Severity: 'LOW', VulnerabilityID: 'example-low' },
          {
            Severity: 'HIGH',
            VulnerabilityID: 'example-high',
            PkgName: 'example',
            InstalledVersion: '1.0.0',
            FixedVersion: '1.0.1',
          },
          { Severity: 'CRITICAL', VulnerabilityID: 'example-unfixed' },
        ],
      },
    ],
  });
  assert.equal(annotations.length, 2);
  assert.match(annotations[0], /fixed in 1.0.1/);
  assert.match(annotations[1], /not yet available/);
});

test('empty scans are clean and malformed reports are rejected', () => {
  assert.deepEqual(annotationsFor('gitleaks', []), []);
  assert.deepEqual(annotationsFor('semgrep', { results: [] }), []);
  assert.deepEqual(annotationsFor('trivy', {}), []);
  assert.throws(() => annotationsFor('unknown', {}));
  assert.throws(() => annotationsFor('gitleaks', {}));
  assert.throws(() => annotationsFor('semgrep', {}));
});
