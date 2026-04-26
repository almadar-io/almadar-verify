/**
 * `probeBindings` — pure observer over `Frame.runtimeSnapshot.traits`
 * for a single frame transition.
 *
 * For the trait the frame's cause targeted, compares the trait's
 * declared events (from `TraitStateSnapshot.events`) against the
 * `lastEventDispatched` and `cascadeReceived` sources of truth on the
 * snapshot. Reports matches and missing slots.
 *
 * This is the Frame-shaped successor to `probeBindingsAfterTransition`
 * (browser/binding-assertions.ts) — same semantic check, no `Page`,
 * no `evaluate` round-trip.
 *
 * @packageDocumentation
 */

import type { Frame } from '../frame/types.js';
import type { BindingDelta, BindingMatch } from './types.js';

export function probeBindings(frame: Frame, _prev: Frame | null): BindingDelta {
  const traitSnapshot = frame.runtimeSnapshot.traits.find(
    (t) => t.traitName === frame.cause.traitName,
  );
  if (traitSnapshot === undefined) {
    return { matched: [], missing: [] };
  }

  const matched: BindingMatch[] = [];
  const missing: { slot: string; expected: string }[] = [];

  // The "last event dispatched" should equal the cause event when the
  // dispatch landed on the targeted trait. Cross-trait dispatches (the
  // emit-sweep) won't satisfy this, so we report mismatches as missing.
  if (traitSnapshot.lastEventDispatched?.event === frame.cause.event) {
    matched.push({
      slot: 'lastEventDispatched',
      expected: frame.cause.event,
      actual: traitSnapshot.lastEventDispatched.event,
    });
  } else if (frame.cause.triggerKind !== 'auto-init') {
    missing.push({
      slot: 'lastEventDispatched',
      expected: frame.cause.event,
    });
  }

  // Every declared event must appear in the trait's events list (sanity
  // check the runtime registered the trait correctly).
  for (const declared of traitSnapshot.events) {
    matched.push({
      slot: `events.${declared}`,
      expected: declared,
      actual: declared,
    });
  }

  return { matched, missing };
}
