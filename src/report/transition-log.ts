/**
 * Transition log writers (JSONL + ASCII TXT).
 *
 * Shared by orbital-verify and runtime-verify for writing
 * transition logs captured during browser verification.
 *
 * @packageDocumentation
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TransitionLogEntry } from '../util/types.js';

/**
 * Write transition log entries as JSONL (one JSON object per line).
 */
export function writeTransitionLogJsonl(
  entries: TransitionLogEntry[],
  outputPath: string,
): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf-8',
  );
}

/**
 * Build an ASCII-formatted transition log string.
 */
export function buildTransitionLogTxt(
  schemaName: string,
  entries: TransitionLogEntry[],
): string {
  const lines: string[] = [];
  lines.push(
    '\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557',
  );
  lines.push(
    `\u2551  Transition Log: ${schemaName.padEnd(43)}\u2551`,
  );
  lines.push(
    '\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D',
  );
  lines.push('');

  for (const entry of entries) {
    const dashLen = Math.max(0, 59 - entry.event.length);
    lines.push(
      `\u2500\u2500\u2500 ${entry.event} ${'\u2500'.repeat(dashLen)}`,
    );
    lines.push(`  State: ${entry.from} \u2192 ${entry.to}`);
    lines.push(`  Payload: ${JSON.stringify(entry.payload)}`);

    const resp = entry.serverResponse;
    if (resp) {
      const status = resp.success ? '200 OK' : 'ERROR: ' + (resp.error ?? 'unknown');
      lines.push(`  Server: ${status}`);
      for (const [entityName, count] of Object.entries(entry.serverDataCounts)) {
        lines.push(`    data.${entityName}: ${count} items`);
      }
      if (Array.isArray(entry.effectResults)) {
        for (const eff of entry.effectResults) {
          const e = eff as Record<string, unknown>;
          const effType = e.effect ?? 'unknown';
          const success = e.success ? 'success' : 'failed';
          const dataLen = Array.isArray(e.data) ? ` (${(e.data as unknown[]).length} items)` : '';
          lines.push(`    effectResults: [${effType} ${e.entityType ?? ''}: ${success}${dataLen}]`);
        }
      }
    } else {
      lines.push('  Server: no response captured');
    }

    const domStr = entry.domEntityCount === -1
      ? 'no entity container'
      : `${entry.domEntityCount} entity rows`;
    lines.push(`  DOM: ${domStr} in #slot-main`);

    if (entry.screenshot) {
      lines.push(`  Screenshot: ${entry.screenshot}`);
    }

    // Append captured almadar logs for this transition
    if (entry.logs && entry.logs.length > 0) {
      lines.push('  Logs:');
      for (const logLine of entry.logs) {
        lines.push(`    ${logLine}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Write an ASCII-formatted transition log to disk.
 */
export function writeTransitionLogTxt(
  schemaName: string,
  entries: TransitionLogEntry[],
  outputPath: string,
): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, buildTransitionLogTxt(schemaName, entries), 'utf-8');
}
