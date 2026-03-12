/**
 * Markdown report generation.
 *
 * @packageDocumentation
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { VerifyReport } from '../util/types.js';

/**
 * Generate a markdown report from verification results.
 */
export function buildMarkdownReport(report: VerifyReport): string {
  const lines: string[] = [];

  lines.push(`# Verification Report`);
  lines.push('');
  lines.push(`- **Date**: ${report.timestamp}`);
  lines.push(`- **URL**: ${report.url}`);
  lines.push(`- **Mode**: ${report.mode}`);
  lines.push('');

  lines.push(`## Summary`);
  lines.push('');
  lines.push(`| Status | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| PASS | ${report.summary.pass} |`);
  lines.push(`| WARN | ${report.summary.warning} |`);
  lines.push(`| ERROR | ${report.summary.error} |`);
  lines.push(`| **Total** | **${report.summary.total}** |`);
  lines.push('');

  // Error details
  const errors = report.results.filter((r) => r.status === 'error');
  if (errors.length > 0) {
    lines.push(`## Errors (${errors.length})`);
    lines.push('');
    for (const item of errors) {
      lines.push(`### ${item.name}`);
      for (const e of item.errors) {
        lines.push(`- ${e.substring(0, 200)}`);
      }
      lines.push('');
    }
  }

  // Warning details
  const warnings = report.results.filter((r) => r.status === 'warning');
  if (warnings.length > 0) {
    lines.push(`## Warnings (${warnings.length})`);
    lines.push('');
    for (const item of warnings) {
      lines.push(`### ${item.name}`);
      for (const w of item.warnings) {
        lines.push(`- ${w.substring(0, 200)}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Write a markdown report to disk.
 */
export function writeMarkdownReport(report: VerifyReport, outputPath: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, buildMarkdownReport(report));
}
