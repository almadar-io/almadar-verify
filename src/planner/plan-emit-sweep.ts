/**
 * `planEmitSweep` — pure planner that produces a step per declared
 * emit, so every event the trait promises to emit gets fired through
 * the bus at least once.
 *
 * This is the lifted version of orbital-verify's Phase 4b interaction
 * loop (phase4-browser.ts §2500-3576): the loop iterates each declared
 * `emits` event and dispatches it via the bus with a mock payload to
 * verify that downstream listening traits handle it correctly. The
 * coverage observer treats these steps as `[emit]`-suffixed coverage
 * keys, separate from the topology walk.
 *
 * Pure. The emit list comes from `collectEmitDeclarations(effects)`
 * (which the caller invokes against the trait's effects array).
 *
 * @packageDocumentation
 */

import type { ExtendedWalkStep, PlanEmitInput } from './types.js';

export function planEmitSweep(input: PlanEmitInput): ExtendedWalkStep[] {
  const { trait, emits } = input;
  const result: ExtendedWalkStep[] = [];

  // Deduplicate by `success` event name; failure events are still
  // captured but as separate steps so each gets fired once.
  const seen = new Set<string>();

  for (const decl of emits) {
    if (decl.success !== undefined && !seen.has(decl.success)) {
      seen.add(decl.success);
      result.push(makeEmitStep(trait.traitName, trait.initialState, decl.success));
    }
    if (decl.failure !== undefined && !seen.has(decl.failure)) {
      seen.add(decl.failure);
      result.push(makeEmitStep(trait.traitName, trait.initialState, decl.failure));
    }
  }

  return result;
}

/**
 * The emit-sweep step targets the trait's initial state because we're
 * dispatching the event from the bus directly, not walking from a
 * particular state. The runtime routes the emit to whichever listening
 * trait handles it; the topology walk in `planWalk` already covers the
 * emitting trait's own transitions. The coverage key uses `[emit]` as
 * the suffix to distinguish from topology coverage.
 */
function makeEmitStep(traitName: string, initialState: string, eventName: string): ExtendedWalkStep {
  return {
    from: initialState,
    event: eventName,
    to: initialState,
    guardCase: null,
    payload: {},
    isRepositioning: false,
    traitName,
    triggerKind: 'bus',
    coverageKey: `${traitName}:${initialState}+${eventName}->${initialState}[emit]`,
  };
}
