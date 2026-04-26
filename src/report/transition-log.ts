/**
 * Transition log writers (JSONL + ASCII TXT).
 *
 * Consume `Frame[]` (the temporal stream produced by `runVerification`)
 * directly. Older callers that fed `TransitionLogEntry[]` were removed
 * in v2.0.0 along with that type — migrate to passing `Frame[]`.
 *
 * @packageDocumentation
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Frame } from '../frame/types.js';

/** Write the frame stream as JSONL (one JSON object per line). */
export function writeTransitionLogJsonl(frames: ReadonlyArray<Frame>, outputPath: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    frames.map((f) => JSON.stringify(frameToLogRecord(f))).join('\n') + '\n',
    'utf-8',
  );
}

/** Build an ASCII-formatted transition log string from frames. */
export function buildTransitionLogTxt(itemName: string, frames: ReadonlyArray<Frame>): string {
  const lines: string[] = [];
  lines.push('╔' + '═'.repeat(64) + '╗');
  lines.push(`║  Transition Log: ${itemName.padEnd(43)}║`);
  lines.push('╚' + '═'.repeat(64) + '╝');
  lines.push('');

  for (const frame of frames) {
    const event = frame.cause.event;
    const dashLen = Math.max(0, 59 - event.length);
    lines.push('─── ' + event + ' ' + '─'.repeat(dashLen));
    lines.push(`  Trigger: ${frame.cause.triggerKind}${frame.cause.isRepositioning ? ' (repositioning)' : ''}`);
    lines.push(`  State: ${frame.stateBefore ?? '∅'} → ${frame.stateAfter ?? '∅'}`);
    lines.push(`  Payload: ${JSON.stringify(frame.payload)}`);

    if (frame.serverResponse !== null) {
      const status = frame.serverResponse.success ? '200 OK' : 'ERROR: ' + (frame.serverResponse.error ?? 'unknown');
      lines.push(`  Server: ${status}`);
      for (const [name, count] of Object.entries(frame.serverResponse.dataEntities)) {
        lines.push(`    data.${name}: ${count} items`);
      }
    }

    for (const eff of frame.effectResults) {
      lines.push(`    effectResults: [${eff.type}: ${eff.status}${eff.error !== undefined ? ' ' + eff.error : ''}]`);
    }

    for (const change of frame.entityChanges) {
      const delta = change.added.length - change.removed.length;
      if (delta !== 0 || change.changed.length > 0) {
        lines.push(`  Entity ${change.entityName}: +${change.added.length}/-${change.removed.length}/~${change.changed.length}`);
      }
    }

    if (frame.consoleDelta.newErrors > 0 || frame.consoleDelta.newWarnings > 0) {
      lines.push(`  Console: ${frame.consoleDelta.newErrors} error(s), ${frame.consoleDelta.newWarnings} warning(s)`);
    }

    if (frame.screenshotPath !== null) {
      lines.push(`  Screenshot: ${frame.screenshotPath}`);
    }

    if (!frame.accepted) {
      lines.push(`  REJECTED`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

/** Write the ASCII transition log to disk. */
export function writeTransitionLogTxt(
  itemName: string,
  frames: ReadonlyArray<Frame>,
  outputPath: string,
): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, buildTransitionLogTxt(itemName, frames), 'utf-8');
}

// ── internal ─────────────────────────────────────────────────────────

function frameToLogRecord(frame: Frame): Record<string, unknown> {
  // Compact projection of the Frame for JSONL — drop bulky snapshots.
  return {
    index: frame.index,
    timestamp: frame.timestamp,
    cause: frame.cause,
    stateBefore: frame.stateBefore,
    stateAfter: frame.stateAfter,
    payload: frame.payload,
    accepted: frame.accepted,
    effectResults: frame.effectResults,
    serverResponse: frame.serverResponse,
    entityDeltas: frame.entityChanges.map((c) => ({
      entityName: c.entityName,
      added: c.added.length,
      removed: c.removed.length,
      changed: c.changed.length,
    })),
    consoleDelta: { errors: frame.consoleDelta.newErrors, warnings: frame.consoleDelta.newWarnings },
    eventLogDelta: frame.eventLogDelta.added.length,
    screenshotPath: frame.screenshotPath,
    errors: frame.errors,
    warnings: frame.warnings,
  };
}
