/**
 * `planWalk` — pure planner that turns a trait into an ordered list of
 * `ExtendedWalkStep`s the driver can fire one-by-one.
 *
 * Wraps `buildEdgeCoveringWalk` from `@almadar/core` (which guarantees
 * 100% transition coverage via greedy DFS + BFS repositioning), then:
 *  1. Prepends a synthetic auto-init step (unless disabled) so the
 *     coverage observer credits the boot INIT without consumer bookkeeping.
 *  2. Decorates every step with `triggerKind` + `coverageKey`.
 *
 * Pure. No browser, no I/O. Unit-testable with inline trait fixtures.
 *
 * @packageDocumentation
 */

import { buildEdgeCoveringWalk } from '@almadar/core';
import type { TriggerKind } from '../frame/types.js';
import type { ExtendedWalkStep, PlanWalkInput } from './types.js';

export function planWalk(input: PlanWalkInput): ExtendedWalkStep[] {
  const { trait, includeAutoInit = true } = input;

  const result: ExtendedWalkStep[] = [];

  if (includeAutoInit) {
    result.push(makeAutoInitStep(trait.traitName, trait.initialState));
  }

  const baseSteps = buildEdgeCoveringWalk(trait.transitions, trait.initialState);
  for (const step of baseSteps) {
    const triggerKind: TriggerKind = step.isRepositioning ? 'replay' : 'bus';
    result.push({
      ...step,
      traitName: trait.traitName,
      triggerKind,
      coverageKey: buildCoverageKey(trait.traitName, step.from, step.event, step.to, step.guardCase),
    });
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
