/**
 * `assertDataMutation` — pure observer over `Frame[]` for Phase 4b+
 * data mutation verification.
 *
 * For each frame whose `cause.testKind === 'data-mutation'`:
 *   - Read `cause.expectedRowDelta` (the entityName + signed delta the
 *     planner attached).
 *   - Look up the matching `EntityChange` in `frame.entityChanges`.
 *   - Verify `change.added.length - change.removed.length === expected.delta`.
 *
 * Pre-v3.0.0 this lived in orbital `phase4-browser.ts:3357-3655` as a
 * loop that navigated to each test's route, replayed paths, clicked
 * affordances, and inspected `countEntityRows(page)` deltas
 * imperatively. The lifted shape reads only the temporal Frame stream
 * — `frame.entityChanges` is the canonical core-typed diff
 * (`EntityRow[]` before/after with `added`/`removed`/`changed` arrays
 * computed by `frame/factory.diffEntities`).
 *
 * Sibling observer `assertMutation` (which takes a `MutationRule`)
 * covers the same semantics for callers that pass rules directly to
 * `runVerification`. This observer covers the planner-extension
 * pathway: `planDataMutationTests` produces the steps, this observer
 * produces the verdicts.
 *
 * @packageDocumentation
 */

import type { Frame } from '../frame/types.js';
import type { Verdict } from './types.js';

export function assertDataMutation(frames: ReadonlyArray<Frame>): Verdict[] {
  const verdicts: Verdict[] = [];

  for (const frame of frames) {
    if (frame.cause.testKind !== 'data-mutation') continue;

    const expected = frame.cause.expectedRowDelta;
    if (expected === undefined) {
      verdicts.push({
        passed: false,
        detail: `data-mutation: frame ${frame.index} (${frame.cause.event}) has no expectedRowDelta on cause — planner bug`,
        evidence: { frameIndices: [frame.index] },
      });
      continue;
    }

    const change = frame.entityChanges.find((c) => c.entityName === expected.entityName);
    if (change === undefined) {
      verdicts.push({
        passed: false,
        detail: `data-mutation: ${frame.cause.event} expected ${expected.entityName} delta ${signDelta(expected.delta)}, but no entityChange recorded for ${expected.entityName}`,
        evidence: { frameIndices: [frame.index] },
      });
      continue;
    }

    const actualDelta = change.added.length - change.removed.length;
    if (actualDelta !== expected.delta) {
      verdicts.push({
        passed: false,
        detail: `data-mutation: ${frame.cause.event} on ${expected.entityName} expected delta ${signDelta(expected.delta)}, got ${signDelta(actualDelta)} (added=${change.added.length}, removed=${change.removed.length})`,
        evidence: { frameIndices: [frame.index] },
      });
      continue;
    }

    verdicts.push({
      passed: true,
      detail: `data-mutation: ${frame.cause.event} on ${expected.entityName} delta = ${signDelta(actualDelta)} as expected`,
      evidence: { frameIndices: [frame.index] },
    });
  }

  return verdicts;
}

function signDelta(d: number): string {
  if (d > 0) return `+${d}`;
  if (d < 0) return `${d}`;
  return '0';
}
