/**
 * `planWalk` — pure planner that turns a trait into an ordered list of
 * `ExtendedWalkStep`s the driver can fire one-by-one.
 *
 * Hermetic-frame mode (v3.13+): emits ONE step per transition with
 * `from = transition.from`, no Eulerian chaining or
 * `replay`-repositioning steps. The kernel's `runVerification`
 * preamble (reset + planReplayTo from initial → step.from) handles
 * getting the trait into `from` before each dispatch, so this planner
 * no longer needs to thread state continuity across emissions.
 *
 * Per-trait output:
 *  1. Synthetic auto-init step (unless disabled) crediting the boot
 *     INIT without consumer bookkeeping.
 *  2. One `triggerKind: 'bus'` step per transition (with pass/fail
 *     guardCase variants when the transition has a guard, mirroring
 *     `buildEdgeCoveringWalk`'s behaviour).
 *
 * Pre-fix: this used `buildEdgeCoveringWalk` which chained transitions
 * into a single Eulerian walk so each step's `from` matched the
 * previous step's `to`. That created cross-frame state dependence —
 * a frame midway through the walk would inherit terminal trait state
 * from earlier frames AND from other planners (planInteractionTests,
 * planUserCrudFlow). The hermetic-frame refactor moved state-setup
 * responsibility into the kernel; this planner now just enumerates
 * the edges to cover.
 *
 * Pure. No browser, no I/O. Unit-testable with inline trait fixtures.
 *
 * @packageDocumentation
 */

import { buildGuardPayloads } from '@almadar/core';
import type { ExtendedWalkStep, PlanWalkInput } from './types.js';

export function planWalk(input: PlanWalkInput): ExtendedWalkStep[] {
  const { trait, includeAutoInit = true } = input;

  const result: ExtendedWalkStep[] = [];

  if (includeAutoInit) {
    result.push(makeAutoInitStep(trait.traitName, trait.initialState));
  }

  // One step per transition. Skip INIT-from-initial because the
  // auto-init step already credits the runtime's boot INIT (firing
  // it again would double-credit the same edge).
  for (const transition of trait.transitions) {
    if (transition.event === 'INIT' && transition.from === trait.initialState) continue;

    if (transition.hasGuard) {
      // Guarded transitions get pass + fail variants. Synthesize each
      // variant's payload from the guard expression itself via
      // `buildGuardPayloads` — pass yields a payload that satisfies
      // the guard (e.g. `{row: {id, name}}` for `@payload.row`); fail
      // yields one that doesn't (e.g. `{row: null}`). Pre-fix this
      // synthesis lived inside `buildEdgeCoveringWalk`; the hermetic-
      // frame planWalk emits steps directly so we recreate the logic
      // at the emission site.
      const guardPayloads = transition.guard !== undefined
        ? buildGuardPayloads(transition.guard)
        : { pass: {}, fail: {} };
      result.push({
        from: transition.from,
        event: transition.event,
        to: transition.to,
        guardCase: 'pass',
        payload: guardPayloads.pass,
        isRepositioning: false,
        traitName: trait.traitName,
        triggerKind: 'bus',
        coverageKey: buildCoverageKey(trait.traitName, transition.from, transition.event, transition.to, 'pass'),
      });
      result.push({
        from: transition.from,
        event: transition.event,
        to: transition.to,
        guardCase: 'fail',
        payload: guardPayloads.fail,
        isRepositioning: false,
        traitName: trait.traitName,
        triggerKind: 'bus',
        coverageKey: buildCoverageKey(trait.traitName, transition.from, transition.event, transition.to, 'fail'),
      });
    } else {
      result.push({
        from: transition.from,
        event: transition.event,
        to: transition.to,
        guardCase: null,
        payload: {},
        isRepositioning: false,
        traitName: trait.traitName,
        triggerKind: 'bus',
        coverageKey: buildCoverageKey(trait.traitName, transition.from, transition.event, transition.to, null),
      });
    }
  }

  return result;
}

/**
 * Build the synthetic auto-init step. The runtime auto-fires INIT from
 * the initial state on mount; the kernel uses this step to credit that
 * boot moment as a Frame without needing the driver to dispatch anything.
 */
function makeAutoInitStep(traitName: string, initialState: string): ExtendedWalkStep {
  return {
    from: initialState,
    event: 'INIT',
    to: initialState,
    guardCase: null,
    payload: {},
    isRepositioning: false,
    traitName,
    triggerKind: 'auto-init',
    coverageKey: buildCoverageKey(traitName, initialState, 'INIT', initialState, null),
  };
}

/**
 * Build the canonical coverage key. Format mirrors `frame/keyOf(cause)`:
 *   `${trait}:${from}+${event}->${to}` (unguarded)
 *   `${trait}:${from}+${event}->${to}[pass|fail]` (guarded)
 *
 * Single source of truth — the coverage observer uses the same scheme,
 * so numerator and denominator match by construction.
 */
function buildCoverageKey(
  traitName: string,
  from: string,
  event: string,
  to: string,
  guardCase: 'pass' | 'fail' | null,
): string {
  const base = `${traitName}:${from}+${event}->${to}`;
  return guardCase === null ? base : `${base}[${guardCase}]`;
}
