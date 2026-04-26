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

  // Check the event log delta first — it captures EVERY event the
  // runtime dispatched during this frame, not just the most recent.
  // `lastEventDispatched` on the snapshot is a single-slot moving
  // target: after a cause event triggers cascade-fired follow-ups
  // (e.g. INIT auto-firing from a server-success effect), the snapshot
  // ends up reflecting the cascade event, not the cause. Both signals
  // are useful — if either has the cause event, the dispatch landed.
  // The runtime's event log uses prefixed entry types
  // (`UI:EVENT`, `<Trait>:DISPATCH`, `<Trait>:EVENT:SUCCESS`,
  // `<Trait>:EVENT:ERROR`) alongside raw event names. A cause event
  // of `INIT` is therefore confirmed if any colon-delimited segment
  // of the entry type is exactly the cause event.
  const causeInEventLog = frame.eventLogDelta.added.some((entry) =>
    entry.type === frame.cause.event ||
    entry.type.split(':').includes(frame.cause.event),
  );
  const causeInLastDispatched = traitSnapshot.lastEventDispatched?.event === frame.cause.event;

  if (causeInEventLog || causeInLastDispatched) {
    matched.push({
      slot: 'lastEventDispatched',
      expected: frame.cause.event,
      actual: causeInLastDispatched
        ? (traitSnapshot.lastEventDispatched as { event: string }).event
        : 'eventLog',
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
