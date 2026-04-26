/**
 * vitest/jest-style test report formatter.
 *
 * Produces a human-readable test report with grouped checks,
 * console errors, and transition summaries per behavior.
 *
 * @packageDocumentation
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { VerifyCheck } from '../util/types.js';
import type { Frame } from '../frame/types.js';

/**
 * Per-frame summary in the test report. Built from the temporal stream
 * `runVerification` produces; replaces the legacy `TransitionLogEntry`.
 */
export interface ReportTransition {
  event: string;
  from: string;
  to: string;
  payload: Record<string, unknown>;
  triggerKind: string;
  accepted: boolean;
}

/** A single behavior's test report entry */
export interface TestReportEntry {
  name: string;
  checks: VerifyCheck[];
  consoleErrors: string[];
  transitionLog: ReportTransition[];
  durationMs: number;
}

/** Project a Frame stream into the report's transition shape. */
export function framesToReportTransitions(frames: ReadonlyArray<Frame>): ReportTransition[] {
  return frames.map((f) => ({
    event: f.cause.event,
    from: f.cause.from,
    to: f.stateAfter ?? f.cause.to,
    payload: f.payload,
    triggerKind: f.cause.triggerKind,
    accepted: f.accepted,
  }));
}

/**
 * Categorize checks into groups for display.
 */
function categorizeChecks(checks: VerifyCheck[]): Map<string, VerifyCheck[]> {
  const groups = new Map<string, VerifyCheck[]>();

  for (const check of checks) {
    let category: string;
    if (check.label.startsWith('Page health:') || check.label === 'App loads successfully' || check.label.startsWith('DOM: #slot-main')) {
      category = 'Page Health';
    } else if (check.label.startsWith('DOM:')) {
      category = 'Pattern Detection';
    } else if (check.label.startsWith('Console:')) {
      category = 'Console';
    } else if (check.label.includes('effect')) {
      category = 'Runtime';
    } else if (check.label.startsWith('Interaction:')) {
      category = 'Interactions';
    } else if (check.label.includes('contract') || check.label.includes('Contract')) {
      category = 'Contracts';
    } else {
      category = 'Other';
    }

    if (!groups.has(category)) {
      groups.set(category, []);
    }
    groups.get(category)!.push(check);
  }

  return groups;
}

/**
 * Format a single behavior's test report.
 */
export function formatTestReport(entry: TestReportEntry): string {
  const { name, checks, consoleErrors, transitionLog, durationMs } = entry;
  const failCount = checks.filter((c) => !c.passed).length;
  const status = failCount > 0 ? 'FAIL' : 'PASS';
  const statusIcon = failCount > 0 ? '\x1b[0;31m FAIL \x1b[0m' : '\x1b[0;32m PASS \x1b[0m';

  const lines: string[] = [];
  lines.push(`${statusIcon} ${name} (${checks.length} checks, ${failCount} failed, ${durationMs}ms)`);
  lines.push('');

  // Grouped checks
  const groups = categorizeChecks(checks);
  for (const [category, groupChecks] of groups) {
    lines.push(`  ${category}`);
    for (const check of groupChecks) {
      const icon = check.passed ? '\x1b[0;32m\u2713\x1b[0m' : '\x1b[0;31m\u2717\x1b[0m';
      lines.push(`    ${icon} ${check.label}`);
      if (!check.passed && check.detail) {
        lines.push(`      \x1b[2m\u2192 ${check.detail}\x1b[0m`);
      }
    }
    lines.push('');
  }

  // Console errors section (deduplicated)
  if (consoleErrors.length > 0) {
    const unique = [...new Set(consoleErrors)];
    lines.push(`  Console Errors (${unique.length})`);
    for (const err of unique.slice(0, 10)) {
      lines.push(`    \x1b[0;31m\u2717\x1b[0m ${err.slice(0, 200)}`);
    }
    if (unique.length > 10) {
      lines.push(`    ... and ${unique.length - 10} more`);
    }
    lines.push('');
  }

  // Transition summary
  if (transitionLog.length > 0) {
    lines.push(`  Transitions (${transitionLog.length} captured)`);
    for (const t of transitionLog) {
      const payloadStr = Object.keys(t.payload).length > 0
        ? ` (payload: ${JSON.stringify(t.payload).slice(0, 80)})`
        : '';
      lines.push(`    ${t.event.padEnd(16)} ${t.from} \u2192 ${t.to}${payloadStr}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format a plain-text (no ANSI) version for file output.
 */
export function formatTestReportPlain(entry: TestReportEntry): string {
  const { name, checks, consoleErrors, transitionLog, durationMs } = entry;
  const failCount = checks.filter((c) => !c.passed).length;
  const status = failCount > 0 ? 'FAIL' : 'PASS';

  const lines: string[] = [];
  lines.push(` ${status}  ${name} (${checks.length} checks, ${failCount} failed, ${durationMs}ms)`);
  lines.push('');

  const groups = categorizeChecks(checks);
  for (const [category, groupChecks] of groups) {
    lines.push(`  ${category}`);
    for (const check of groupChecks) {
      const icon = check.passed ? '\u2713' : '\u2717';
      lines.push(`    ${icon} ${check.label}`);
      if (!check.passed && check.detail) {
        lines.push(`      -> ${check.detail}`);
      }
    }
    lines.push('');
  }

  if (consoleErrors.length > 0) {
    const unique = [...new Set(consoleErrors)];
    lines.push(`  Console Errors (${unique.length})`);
    for (const err of unique.slice(0, 10)) {
      lines.push(`    \u2717 ${err.slice(0, 200)}`);
    }
    if (unique.length > 10) {
      lines.push(`    ... and ${unique.length - 10} more`);
    }
    lines.push('');
  }

  if (transitionLog.length > 0) {
    lines.push(`  Transitions (${transitionLog.length} captured)`);
    for (const t of transitionLog) {
      const payloadStr = Object.keys(t.payload).length > 0
        ? ` (payload: ${JSON.stringify(t.payload).slice(0, 80)})`
        : '';
      lines.push(`    ${t.event.padEnd(16)} ${t.from} -> ${t.to}${payloadStr}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Write a consolidated test report for multiple behaviors to disk.
 */
export function writeTestReport(
  entries: TestReportEntry[],
  outputPath: string,
): void {
  mkdirSync(dirname(outputPath), { recursive: true });

  const lines: string[] = [];
  const totalChecks = entries.reduce((sum, e) => sum + e.checks.length, 0);
  const totalFailed = entries.reduce((sum, e) => sum + e.checks.filter((c) => !c.passed).length, 0);
  const failedEntries = entries.filter((e) => e.checks.some((c) => !c.passed));
  const passedEntries = entries.filter((e) => e.checks.every((c) => c.passed));

  lines.push('Verification Test Report');
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push(`Total: ${entries.length} behaviors, ${totalChecks} checks, ${totalFailed} failed`);
  lines.push('');
  lines.push('='.repeat(70));
  lines.push('');

  // Failed behaviors first
  for (const entry of failedEntries) {
    lines.push(formatTestReportPlain(entry));
    lines.push('-'.repeat(70));
    lines.push('');
  }

  // Passed behaviors (compact)
  if (passedEntries.length > 0) {
    lines.push(`Passed (${passedEntries.length}):`);
    for (const entry of passedEntries) {
      lines.push(`  \u2713 ${entry.name} (${entry.checks.length} checks, ${entry.durationMs}ms)`);
    }
    lines.push('');
  }

  writeFileSync(outputPath, lines.join('\n'), 'utf-8');
}
