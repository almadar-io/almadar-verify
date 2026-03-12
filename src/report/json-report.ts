/**
 * JSON report generation.
 *
 * @packageDocumentation
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { VerifyReport, VerifyResult } from '../util/types.js';

/**
 * Build a JSON report from verification results.
 */
export function buildJsonReport(
  url: string,
  mode: 'playground' | 'app',
  results: VerifyResult[]
): VerifyReport {
  const pass = results.filter((r) => r.status === 'pass').length;
  const error = results.filter((r) => r.status === 'error').length;
  const warning = results.filter((r) => r.status === 'warning').length;

  return {
    timestamp: new Date().toISOString(),
    url,
    mode,
    summary: { total: results.length, pass, error, warning },
    results,
  };
}

/**
 * Write a JSON report to disk.
 */
export function writeJsonReport(report: VerifyReport, outputPath: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
}
