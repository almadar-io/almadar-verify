/**
 * `assertWalkStepsFired` — every planned dispatch the runtime REJECTED is a
 * finding, not a covered transition.
 *
 * `decideAccepted` (`driver/tick.ts`) folds the runtime's own
 * `transitioned` verdict and the state contract into `frame.accepted`;
 * until this observer existed nothing turned an `accepted === false` bus
 * frame into a failed verdict — it was logged as `REJECTED` and the run
 * stayed green (`coverage` even credited it). Guard-fail and malformed
 * variants are excluded: for those, rejection IS the expectation, and
 * `assertGuardParity` owns the divergence. Frames carrying dispatch
 * errors are excluded too — `collectDispatchErrors` already reported them.
 *
 * @packageDocumentation
 */

import { LIFECYCLE_EVENTS } from '@almadar/runtime';
import type { Frame } from '../frame/types.js';
import type { Verdict } from './types.js';

/** Lifecycle events are broadcast to every trait and the runtime's `transitioned`
 *  is orbital-wide for them (another trait's INIT arm firing says nothing about
 *  this one) — a per-trait verdict on them is not decidable through the bus. */
const LIFECYCLE: ReadonlySet<string> = new Set(LIFECYCLE_EVENTS);

/**
 * @param effectEmittedByTrait — per trait, the events its own effects fire
 *   (`fetch`/`persist` success and failure routes). The walk still dispatches
 *   them by hand, but by then the effect has usually already fired them and
 *   moved the trait on; their proof is the cascade credit, never this verdict.
 * @param oneShotInitialByTrait — per trait, its initial state when NO
 *   transition from another state leads back to it (PF-17c: PF's
 *   InvoiceLifecycle `draft` — `REOPEN_INVOICE` goes to `sent` by design).
 *   Once the walk advances past such a state, a later planned from-initial
 *   step is unreachable — the playground server's singleton runtime keeps
 *   its FSM state across the walker's hermetic resets (`/api/mock/reset`
 *   clears only the mock store), so the dispatch lands on a trait that is
 *   observably NOT at `from`: either `stateBefore` already reads past it,
 *   or the runtime rejects (`transitioned: false`) and the settle lands on
 *   a state other than `from` (a genuine rejection AT `from` holds the
 *   state and stays a finding). Skipped with a note here, never counted as
 *   fired, never flagged.
 */
export function assertWalkStepsFired(
  frames: ReadonlyArray<Frame>,
  effectEmittedByTrait: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  oneShotInitialByTrait: ReadonlyMap<string, string> = new Map(),
): Verdict {
  const failures: string[] = [];
  const indices: number[] = [];
  const skips: string[] = [];
  let checked = 0;
  for (const frame of frames) {
    if (frame.cause.triggerKind !== 'bus') continue;
    if (frame.cause.isRepositioning) continue;
    if (LIFECYCLE.has(frame.cause.event)) continue;
    if (effectEmittedByTrait.get(frame.cause.traitName)?.has(frame.cause.event) === true) continue;
    // Only the walk's own `success` variants (unguarded + guard-pass): the
    // emit sweep and the extension planners dispatch probes with their own
    // acceptance contracts and their own observers.
    if (frame.cause.payloadCase !== 'success' || frame.cause.testKind !== undefined) continue;
    if (frame.cause.guardCase === 'fail') continue;
    if (frame.errors.length > 0) continue;
    if (!frame.accepted && oneShotInitialByTrait.get(frame.cause.traitName) === frame.cause.from) {
      const alreadyPastIt = frame.stateBefore !== null && frame.stateBefore !== frame.cause.from;
      const settledElsewhere =
        frame.serverResponse?.transitioned === false &&
        frame.stateAfter !== null &&
        frame.stateAfter !== frame.cause.from;
      if (alreadyPastIt || settledElsewhere) {
        skips.push(
          `${frame.cause.traitName}.${frame.cause.event} from '${frame.cause.from}' — initial state has no incoming ` +
          `edge and the trait was not at it (before: '${frame.stateBefore ?? 'null'}', after: '${frame.stateAfter ?? 'null'}')`,
        );
        continue;
      }
    }
    checked += 1;
    if (frame.accepted) continue;
    const runtimeSaid = frame.serverResponse?.transitioned === false
      ? 'the runtime reported no arm accepted it'
      : `state settled at '${frame.stateAfter ?? 'null'}' instead of '${frame.cause.to}'`;
    failures.push(
      `transition-not-fired: ${frame.cause.traitName}.${frame.cause.event} from '${frame.cause.from}' — ${runtimeSaid}`,
    );
    indices.push(frame.index);
  }
  const skipNote = skips.length > 0 ? `; ${skips.length} from-initial step(s) skipped — ${skips.join('; ')}` : '';
  if (failures.length > 0) {
    return {
      passed: false,
      detail: `walk: ${failures.length}/${checked} planned dispatch(es) never fired — ${failures.join('; ')}${skipNote}`,
      evidence: { frameIndices: indices },
    };
  }
  return {
    passed: true,
    detail: `walk: ${checked} planned dispatch(es) fired as the runtime's own verdict confirms${skipNote}`,
    evidence: { frameIndices: [] },
  };
}
