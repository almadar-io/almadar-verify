/**
 * `assertClickNoListener` — pure observer over `Frame[]` for gap #0
 * defense-in-depth.
 *
 * When a verifier-originated DOM click fires, the button emits a bus event.
 * This observer checks that at least one trait subscribed to that event:
 *   - Self-targeting: the emitting trait has a transition on the event.
 *   - Cross-trait: some other trait's `cascadeReceived` grew with the event
 *     (meaning it arrived via a `listens` subscription).
 *
 * Defense-in-depth alongside the L1 `ELOLO_BUTTON_TRANSITION_UNREACHABLE`
 * parser rule and the L2 orb-validator listens-integrity pass. Catches the
 * "compiled-path emits bare key" regression where `TraitScopeProvider` is
 * absent and the qualified bus key never reaches subscribers.
 *
 * @packageDocumentation
 */

import type { OrbitalSchema } from '@almadar/core';
import type { Frame } from '../frame/types.js';
import type { Verdict } from './types.js';

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
