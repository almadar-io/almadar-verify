/**
 * Ref-trait invariant check (VG6).
 *
 * A trait reference (a molecule or organism `uses` an atom and inlines
 * one of its traits) must land in the runtime with the atom's full
 * state machine — at least one state and at least one event. When the
 * compiler's inline pass silently drops a trait (e.g. the `_resolved`
 * unwrap is missed or an override rewrites events into an empty map),
 * the generated runtime still boots, `getSnapshot()` still reports the
 * trait, but the state machine is hollow: no states, no events, no
 * transitions. Users never see the modal/list/form the atom defined;
 * the verifier, absent this check, never catches it either.
 *
 * This gate walks every trait in `getTraitSnapshots()` and fails fast
 * on any trait with an empty `states[]` or `events[]`. Runs once at
 * verify init (or before the first pass), not per-transition.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import { readTraitSnapshots, type TraitStateSnapshot } from '../runtime/state-bridge.js';

export interface RefTraitInvariantCheck {
  traitName: string;
  stateCount: number;
  eventCount: number;
  passed: boolean;
  detail: string;
}

export interface RefTraitInvariantResult {
  /** One entry per trait snapshot observed. */
  checks: RefTraitInvariantCheck[];
  /** True when every trait passed. False means at least one hollow trait. */
  allPassed: boolean;
  /** Number of traits the bridge reported — useful for sanity-checking. */
  traitCount: number;
}

/**
 * Apply the VG6 invariant over every registered trait snapshot.
 * Pure function over the snapshot array — exposed for tests and for
 * consumers that already have the snapshots in hand.
 */
export function checkRefTraitInvariant(
  snapshots: TraitStateSnapshot[],
): RefTraitInvariantResult {
  const checks = snapshots.map((s): RefTraitInvariantCheck => {
    const stateCount = s.states.length;
    const eventCount = s.events.length;
    const passed = stateCount > 0 && eventCount > 0;
    const detail = passed
      ? `${s.traitName}: ${stateCount} state(s), ${eventCount} event(s)`
      : `${s.traitName}: hollow trait — states=${stateCount}, events=${eventCount}. ` +
        `Likely a silent inline-phase drop in the compiler (missed _resolved unwrap ` +
        `or an override that rewrote events into an empty map).`;
    return { traitName: s.traitName, stateCount, eventCount, passed, detail };
  });
  return {
    checks,
    allPassed: checks.every((c) => c.passed),
    traitCount: snapshots.length,
  };
}

/**
 * Read the trait snapshot surface and apply the invariant. Returns
 * `{ checks: [], allPassed: true, traitCount: 0 }` when the runtime
 * does not expose `getTraitSnapshots` (older bundle). Callers that
 * want to treat "no snapshots" as a failure should inspect
 * `traitCount` themselves.
 */
export async function assertRefTraitInvariant(
  page: Page,
): Promise<RefTraitInvariantResult> {
  const snapshots = await readTraitSnapshots(page);
  return checkRefTraitInvariant(snapshots);
}
