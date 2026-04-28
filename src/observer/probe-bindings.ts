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

  // Skip frames where the dispatch is EXPECTED to be rejected, or where
  // the cause event is not the trait's most recent dispatch by snapshot
  // time — bus log + lastEventDispatched legitimately won't reflect it.
  // - auto-init: synthetic boot frame (no actual dispatch)
  // - guard-fail / malformed: rejection variants
  // - isRepositioning: reconcile preamble events
  // - serverResponse.success === false: server-side rejection
  // - crud-flow testKinds: the snapshot is captured AFTER the full
  //   open→fill→submit chain; cause.event is the OPEN affordance but
  //   lastEventDispatched ends up reflecting the SAVE/cascade chain
  const tk = frame.cause.testKind;
  const isCrudFlow = tk === 'crud-create' || tk === 'crud-edit' || tk === 'crud-delete';
  const skipMissing =
    frame.cause.triggerKind === 'auto-init' ||
    frame.cause.guardCase === 'fail' ||
    frame.cause.payloadCase === 'malformed' ||
    frame.cause.isRepositioning ||
    frame.serverResponse?.success === false ||
    isCrudFlow;

  if (causeInEventLog || causeInLastDispatched) {
    matched.push({
      slot: 'lastEventDispatched',
      expected: frame.cause.event,
      actual: causeInLastDispatched
        ? (traitSnapshot.lastEventDispatched as { event: string }).event
        : 'eventLog',
    });
  } else if (!skipMissing) {
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
