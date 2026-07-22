/**
 * `assertClickNoListener` — pure observer over `Frame[]` for gap #0
 * defense-in-depth.
 *
 * When a verifier-originated DOM click fires, the button emits a bus event.
 * This observer checks that at least one trait subscribed to that event:
 *   - Self-targeting: the emitting trait has a transition on the event.
 *   - Embed-chain: an embedding host (transitively, via the schema's embed
 *     relationship) handles the event or is the source of a declared listens
 *     route — embedded chrome emits under its embedder's scope, so the
 *     runtime delivers to the host, never to a subscription on the child's
 *     own bus key.
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
import { collectEmbeddedTraitReferrers } from '@almadar/core';
import type { Frame } from '../frame/types.js';
import type { Verdict } from './types.js';
import { buildDeclaredListeners, buildTraitTransitions } from './click-wiring-audit.js';

export function assertClickNoListener(
  frames: ReadonlyArray<Frame>,
  orbital: OrbitalSchema,
): Verdict[] {
  const traitTransitions = buildTraitTransitions(orbital);
  const declaredListeners = buildDeclaredListeners(orbital);
  // Embedded chrome (named `<trait.X />` embeds and Inline*Render children)
  // emits under its EMBEDDER's scope — the runtime's embed routing delivers
  // the event to the embedding host, not via a bus subscription on the
  // child's own key. Walk the embed chain upward and credit the click when
  // any host handles or subscribes to the event; a chain with no handler
  // anywhere is still a dead affordance.
  const embedHosts = collectEmbeddedTraitReferrers(orbital);
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

    // Embed-chain delivery: does an embedding host (transitively) handle or
    // subscribe to the event? Mirrors the runtime's embed routing.
    let embedWired = false;
    const seenHosts = new Set<string>([traitName]);
    for (
      let host = embedHosts.get(traitName);
      host !== undefined && !seenHosts.has(host);
      host = embedHosts.get(host)
    ) {
      seenHosts.add(host);
      const hostSources = declaredListeners.get(event);
      if (
        traitTransitions.get(host)?.has(event) === true ||
        (hostSources !== undefined && hostSources.has(host))
      ) {
        embedWired = true;
        break;
      }
    }
    if (embedWired) continue;

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
        detail: `bus:click-no-listener — ${traitName} DOM click emitted "${event}" but no trait subscribed (self-targeting: no, embed-chain: no, cross-trait cascade: no)`,
        evidence: {
          frameIndices: [frame.index],
        },
      });
    }
  }

  return verdicts;
}
