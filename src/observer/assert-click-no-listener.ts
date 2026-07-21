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

import type { OrbitalSchema } from '@almadar/core';
import type { Frame } from '../frame/types.js';
import type { Verdict } from './types.js';
import { buildDeclaredListeners, buildTraitTransitions } from './click-wiring-audit.js';

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
