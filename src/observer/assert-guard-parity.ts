/**
 * `assertGuardParity` — pure in-run observer over `Frame[]` for the
 * GUARD-LAMBDA-DROP fingerprint.
 *
 * Every frame carries both the planner's prediction
 * (`cause.guardCase`) and the runtime's actual verdict
 * (`accepted`, set by `tick`'s `decideAccepted`). When a guard lambda
 * is dropped between planner and runtime, the two disagree: a
 * `guardCase: 'pass'` dispatch the planner built to satisfy the guard
 * gets rejected (or a `'fail'` dispatch is accepted). Because both
 * signals live on the same frame, no cross-run diff is needed — the
 * divergence is decided in-run.
 *
 * For each non-auto-init, non-repositioning frame whose
 * `cause.guardCase` is `'pass'` or `'fail'`, the runtime's `accepted`
 * must match the prediction: `'pass'` → accepted true, `'fail'` →
 * accepted false. Frames with `guardCase: null` (unguarded) are not
 * guard predictions and are skipped.
 *
 * Pure. Reads only `Frame.cause` + `Frame.accepted`.
 *
 * @packageDocumentation
 */

import type { Frame } from '../frame/types.js';
import type { Verdict } from './types.js';

export function assertGuardParity(frames: ReadonlyArray<Frame>): Verdict {
  const failures: string[] = [];
  const indices: number[] = [];
  let checked = 0;

  for (const frame of frames) {
    if (frame.cause.triggerKind === 'auto-init') continue;
    if (frame.cause.isRepositioning) continue;

    const predicted = frame.cause.guardCase;
    if (predicted !== 'pass' && predicted !== 'fail') continue;

    checked += 1;
    const expectedAccepted = predicted === 'pass';
    if (frame.accepted !== expectedAccepted) {
      failures.push(
        `frame ${frame.index}: ${frame.cause.traitName}.${frame.cause.event} predicted guard '${predicted}' (accepted=${expectedAccepted}), runtime accepted=${frame.accepted}`,
      );
      indices.push(frame.index);
    }
  }

  if (failures.length > 0) {
    return {
      passed: false,
      detail: `assertGuardParity: ${failures.length}/${checked} guard prediction(s) diverged from runtime — ${failures.join('; ')}`,
      evidence: { frameIndices: indices },
    };
  }

  return {
    passed: true,
    detail: `assertGuardParity: ${checked} guard prediction(s) matched runtime`,
    evidence: { frameIndices: [] },
  };
}
