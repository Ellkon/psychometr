#!/usr/bin/env node
/**
 * Publish scanner locations as GitHub annotations with a read-only job token.
 * Never include source snippets, matched secrets, or raw scanner error text.
 * Scanner steps keep their own exit codes; this is reporting, not a gate bypass.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(value) {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

export function annotationsFor(scanner, report) {
  let findings;
  switch (scanner) {
    case 'gitleaks':
      findings = report.map((finding) => ({
        file: finding.File,
        line: finding.StartLine,
        message: `Gitleaks: ${finding.RuleID} (commit ${finding.Commit}); value redacted.`,
      }));
      break;
    case 'semgrep':
      findings = report.results.map((finding) => ({
        file: finding.path,
        line: finding.start.line,
        message: `Semgrep: ${finding.check_id}`,
      }));
      for (const error of report.errors ?? []) {
        findings.push({ message: `Semgrep scan error: ${error.type}` });
      }
      break;
    case 'trivy':
      findings = (report.Results ?? []).flatMap((result) => [
        ...(result.Vulnerabilities ?? [])
          .filter((finding) => ['HIGH', 'CRITICAL'].includes(finding.Severity))
          .map((finding) => ({
            file: result.Target,
            message: `Trivy: ${finding.Severity} ${finding.VulnerabilityID} in ${finding.PkgName}@${finding.InstalledVersion}; fixed in ${finding.FixedVersion || 'not yet available'}`,
          })),
        ...(result.Secrets ?? [])
          .filter((finding) => ['HIGH', 'CRITICAL'].includes(finding.Severity))
          .map((finding) => ({
            file: result.Target,
            line: finding.StartLine,
            message: `Trivy: ${finding.Severity} secret rule ${finding.RuleID}; value redacted.`,
          })),
      ]);
      break;
    default:
      throw new Error('Unsupported scanner');
  }

  return findings.map(({ file, line, message }) => {
    const location = file
      ? `file=${escapeProperty(file)},line=${Number.isSafeInteger(line) && line > 0 ? line : 1},`
      : '';
    return `::error ${location}title=${escapeProperty(scanner)}::${escapeData(message)}`;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [scanner, reportPath] = process.argv.slice(2);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    const annotations = annotationsFor(scanner, report);
    for (const annotation of annotations) console.log('%s', annotation);
    console.log('Security findings reported: %d', annotations.length);
  } catch {
    // JSON parser errors can contain fragments of a secret-bearing report.
    console.error('::error::Security report is missing or invalid; inspect the scanner step.');
    process.exitCode = 1;
  }
}
