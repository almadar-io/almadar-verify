/**
 * Console message categorization and reporting.
 *
 * @packageDocumentation
 */

import type { ConsoleEntry } from '../util/types.js';

/** Categorized console report */
export interface ConsoleReport {
  errorCount: number;
  warningCount: number;
  infoCount: number;
  errors: string[];
  warnings: string[];
  /** Unique error patterns (deduplicated by first 80 chars) */
  uniqueErrors: string[];
}

/**
 * Build a console report from collected entries.
 */
export function buildConsoleReport(entries: ConsoleEntry[]): ConsoleReport {
  const errors = entries.filter((e) => e.type === 'error').map((e) => e.text);
  const warnings = entries.filter((e) => e.type === 'warning').map((e) => e.text);
  const infoCount = entries.filter((e) => e.type === 'info').length;

  // Deduplicate errors by first 80 characters
  const seen = new Set<string>();
  const uniqueErrors: string[] = [];
  for (const err of errors) {
    const key = err.substring(0, 80);
    if (!seen.has(key)) {
      seen.add(key);
      uniqueErrors.push(err);
    }
  }

  return {
    errorCount: errors.length,
    warningCount: warnings.length,
    infoCount,
    errors,
    warnings,
    uniqueErrors,
  };
}
