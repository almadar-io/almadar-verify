/**
 * `assertClickNoListener` — pure observer over `Frame[]` for gap #0
 * defense-in-depth.
 *
 * When a verifier-originated DOM click fires, the button emits a bus event.
 * This observer checks that at least one trait subscribed to that event:
 *   - Self-targeting: the emitting trait has a transition on the event.
 *   - Declared cross-trait: some trait's `listens` block subscribes to the
 *     event from this emitter (the schema-level wiring contract).
 *   - Runtime cross-trait: some other trait's `cascadeReceived` grew with the
 *     event (meaning it actually arrived via a `listens` subscription).
 *
 * The declared-listens check is what keeps this honest on the compiled path:
 * the compiled trait snapshot hardcodes `cascadeReceived: []` (the codegen
 * doesn't track received cross-trait events), so the runtime-cascade signal
 * is never present there — a declared subscriber must not be reported as
 * "no listener". The runtime-cascade check still catches the case where NO
 * subscriber is declared yet an event somehow cascades.
 *
 * Defense-in-depth alongside the L1 `ELOLO_BUTTON_TRANSITION_UNREACHABLE`
 * parser rule and the L2 orb-validator listens-integrity pass. Catches the
 * genuine "dead button" case: a click emits an event no trait handles
 * (self-transition) or subscribes to (declared listens or runtime cascade).
 *
 * @packageDocumentation
 */

import type { OrbitalSchema, TraitEventListener } from '@almadar/core';
import type { Frame } from '../frame/types.js';
import type { Verdict } from './types.js';

/**
 * For each event, the set of emitter trait-names that some trait declares a
 * `listens` subscription for. `'*'` means the listener accepts the event from
 * any source. Used to credit a declared cross-trait subscriber even when the
 * runtime path doesn't surface `cascadeReceived`.
 */
function buildDeclaredListeners(orbital: OrbitalSchema): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const orb of orbital.orbitals) {
    for (const traitRef of orb.traits) {
      if (typeof traitRef !== 'object' || !('name' in traitRef)) continue;
      const listens = (traitRef as { listens?: ReadonlyArray<TraitEventListener> }).listens ?? [];
      for (const listener of listens) {
        if (typeof listener.event !== 'string') continue;
        const sources = map.get(listener.event) ?? new Set<string>();
        const source = listener.source;
        if (source !== undefined && 'kind' in source && source.kind === 'trait' && typeof source.trait === 'string') {
          sources.add(source.trait);
        } else {
          sources.add('*');
        }
        map.set(listener.event, sources);
      }
    }
  }
  return map;
}

/**
 * Build a map of trait-name → Set<event> from the schema's state machines.
 */
function buildTraitTransitions(orbital: OrbitalSchema): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const orb of orbital.orbitals) {
    for (const traitRef of orb.traits) {
      if (typeof traitRef !== 'object' || !('name' in traitRef)) continue;
      const traitName = traitRef.name as string;
      const events = new Set<string>();
      if (
        'stateMachine' in traitRef &&
        traitRef.stateMachine &&
        'transitions' in traitRef.stateMachine &&
        Array.isArray(traitRef.stateMachine.transitions)
      ) {
        for (const trans of traitRef.stateMachine.transitions) {
          if (trans && typeof trans === 'object' && 'event' in trans) {
            events.add((trans as { event: string }).event);
          }
        }
      }
      map.set(traitName, events);
    }
  }
  return map;
}

export function assertClickNoListener(
  frames: ReadonlyArray<Frame>,
  orbital: OrbitalSchema,
): Verdict[] {
  const traitTransitions = buildTraitTransitions(orbital);
  const declaredListeners = buildDeclaredListeners(orbital);
  const verdicts: Verdict[] = [];

  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i];
    // Only DOM-triggered frames (button clicks, form submits).
    if (frame.cause.triggerKind !== 'dom') continue;

    const traitName = frame.cause.traitName;
    const event = frame.cause.event;

    // Self-targeting: does the emitting trait handle this event itself?
    const selfEvents = traitTransitions.get(traitName);
    if (selfEvents?.has(event)) {
      continue;
    }

    // Declared cross-trait: does any trait subscribe to this event from this
    // emitter (or from any source)? The schema-level `listens` wiring is the
    // subscription contract — credit it even when the runtime path can't
    // surface `cascadeReceived` (the compiled snapshot hardcodes it empty).
    const sources = declaredListeners.get(event);
    if (sources !== undefined && (sources.has('*') || sources.has(traitName))) {
      continue;
    }

    // Cross-trait: did any trait receive this event via cascade since the
    // previous frame? `cascadeReceived` accumulates; we diff lengths.
    let hasListener = false;
    const prev = frames[i - 1];

    for (const trait of frame.runtimeSnapshot.traits) {
      const prevTrait = prev.runtimeSnapshot.traits.find(
        (t) => t.traitName === trait.traitName,
      );
      const prevCascades = prevTrait?.cascadeReceived ?? [];
      const currCascades = trait.cascadeReceived ?? [];
      const newCount = currCascades.length - prevCascades.length;
      if (newCount <= 0) continue;

      // Only inspect the newly appended tail.
      const newCascades = currCascades.slice(prevCascades.length);
      for (const cascade of newCascades) {
        if (cascade.event === event) {
          hasListener = true;
          break;
        }
      }
      if (hasListener) break;
    }

    if (!hasListener) {
      verdicts.push({
        passed: false,
        detail: `bus:click-no-listener — ${traitName} DOM click emitted "${event}" but no trait subscribed (self-targeting: no, cross-trait cascade: no)`,
        evidence: {
          frameIndices: [frame.index],
        },
      });
    }
  }

  return verdicts;
}
