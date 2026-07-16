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

    // Frames rejected for dispatch health (e.g. `stateless dispatch:
    // getState returned null` — the driver's state reader, not the
    // guard) carry `accepted=false` regardless of guard semantics.
    // Counting them here conflates two checks: dispatch health is
    // asserted by the console/stateless check; parity only judges
    // frames whose dispatch was clean. A real GUARD-LAMBDA-DROP has
    // no dispatch errors — the event delivers fine, the guard just
    // answers wrong — so skipping errored frames cannot mask it.
    if (frame.errors.length > 0) continue;

    checked += 1;
    // `decideAccepted` ALREADY folds the planner's `guardCase` in: a 'pass'
    // frame is `accepted` iff it reached `to`; a 'fail' frame is `accepted`
    // iff the state correctly HELD. So `accepted` is the parity signal — it
    // means "the compiled guard behaved as the planner predicted." A guard
    // that diverges (the GUARD-LAMBDA-DROP fingerprint) yields `accepted=false`
    // for either guardCase. (The earlier `'fail' → accepted=false` form
    // double-inverted: it false-positived on every correctly-rejected guard.)
    if (!frame.accepted) {
      failures.push(
        `frame ${frame.index}: ${frame.cause.traitName}.${frame.cause.event} guard '${predicted}' dispatch behaved unexpectedly (runtime did not match the predicted ${predicted})`,
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
