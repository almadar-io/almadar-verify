/**
 * `planEmitSweep` — pure planner that produces a step per declared
 * emit, so every event the trait promises to emit gets fired through
 * the bus at least once.
 *
 * This is the lifted version of orbital-verify's Phase 4b interaction
 * loop (phase4-browser.ts §2500-3576): the loop iterates each declared
 * `emits` event and dispatches it via the bus with a mock payload to
 * verify that downstream listening traits handle it correctly. The
 * coverage observer treats these steps as `[emit]`-suffixed coverage
 * keys, separate from the topology walk.
 *
 * Pure. The emit list comes from `collectEmitDeclarations(effects)`
 * (which the caller invokes against the trait's effects array).
 *
 * @packageDocumentation
 */

import type { EventPayload, Orbital, OrbitalSchema } from '@almadar/core';
import { dispatchNavigates } from './internal/orbital-walk.js';
import { collectEntityFields, synthesizeSuccessPayload } from './internal/payload-synth.js';
import type { ExtendedWalkStep, PlanEmitInput } from './types.js';
import type { TraitWalkConfig } from '../engine/types.js';

export function planEmitSweep(input: PlanEmitInput): ExtendedWalkStep[] {
  const { trait, emits, schema, orb } = input;
  const result: ExtendedWalkStep[] = [];

  // Deduplicate by `success` event name; failure events are still
  // captured but as separate steps so each gets fired once.
  const seen = new Set<string>();
  const entityFieldsByName = schema !== undefined ? collectEntityFields(schema) : {};
  const payloadOf = (eventName: string) => sweptPayload(trait, eventName, entityFieldsByName);

  for (const decl of emits) {
    if (decl.success !== undefined && !seen.has(decl.success)) {
      seen.add(decl.success);
      result.push(makeEmitStep(trait.traitName, trait.initialState, decl.success, schema, orb, payloadOf(decl.success)));
    }
    if (decl.failure !== undefined && !seen.has(decl.failure)) {
      seen.add(decl.failure);
      result.push(makeEmitStep(trait.traitName, trait.initialState, decl.failure, schema, orb, payloadOf(decl.failure)));
    }
  }

  return result;
}

/** A valid payload for a swept event, synthesized from its declared `payloadSchema` (G-VERIFY-042); `{}` when it declares none. */
function sweptPayload(
  trait: TraitWalkConfig,
  eventName: string,
  entityFieldsByName: ReturnType<typeof collectEntityFields>,
): EventPayload {
  const decl = trait.events?.find((e) => e.key === eventName);
  return synthesizeSuccessPayload(decl?.payloadSchema, trait.linkedEntity, entityFieldsByName);
}

/**
 * The emit-sweep step targets the trait's initial state because we're
 * dispatching the event from the bus directly, not walking from a
 * particular state. The runtime routes the emit to whichever listening
 * trait handles it; the topology walk in `planWalk` already covers the
 * emitting trait's own transitions. The coverage key uses `[emit]` as
 * the suffix to distinguish from topology coverage.
 *
 * `navigates` is looked up through `dispatchNavigates` — the SAME oracle
 * `planWalk`/`planClickPathSamples`/`planReplayTo` already consult —
 * because a swept event can be declared on a trait (`emits { BACK }`,
 * `NoteDetailLayout`'s composed `std-detail-layout`) whose OWN transition
 * from its initial state carries a `navigate`/`navigate-back` effect, or
 * whose only receiver is a LISTENER's triggered arm (`NoteBacklinksRouter
 * listens NoteSubpages.SELECT_RELATED -> SELECT_RELATED`, which itself
 * navigates). Before this, an emit-sweep re-dispatch of an already-
 * click-path-verified navigating event fired a SECOND time via the bus,
 * found the trait genuinely unmounted (the click-path step already
 * navigated away), and mis-reported it as `stateless dispatch` — the same
 * failure `toEdgeWalkTransition`'s `navigates` derivation exists to
 * prevent, just missed here because this planner never consulted it.
 */
function makeEmitStep(
  traitName: string,
  initialState: string,
  eventName: string,
  schema: OrbitalSchema | undefined,
  orb: Orbital | undefined,
  payload: EventPayload,
): ExtendedWalkStep {
  const navigates = schema !== undefined && orb !== undefined
    && dispatchNavigates(schema, orb, traitName, eventName);
  return {
    from: initialState,
    event: eventName,
    to: initialState,
    guardCase: null,
    payload,
    isRepositioning: false,
    traitName,
    triggerKind: 'bus',
    coverageKey: `${traitName}:${initialState}+${eventName}->${initialState}[emit]`,
    ...(navigates && { navigates: true }),
  };
}
