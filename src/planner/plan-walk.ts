/**
 * `planWalk` — pure planner that turns a trait into an ordered list of
 * `ExtendedWalkStep`s the driver can fire one-by-one.
 *
 * Hermetic-frame mode (v3.13+): emits ONE step per transition with
 * `from = transition.from`, no Eulerian chaining or
 * `replay`-repositioning steps. The kernel's `runVerification`
 * preamble (reset + planReplayTo from initial → step.from) handles
 * getting the trait into `from` before each dispatch.
 *
 * Three-variant emission (v3.14+): for each non-INIT-from-initial
 * transition the planner emits up to three explicit variants so both
 * the rejection and success paths get coverage:
 *
 *   1. `malformed`: empty-payload `{}`. When the event has at least
 *      one `required: true` payload field, the API-boundary validator
 *      rejects it and `frame.serverResponse.success === false`. If the
 *      event has no required fields the `malformed` and `success`
 *      payloads collapse to the same `{}`, so we skip emission to
 *      avoid duplicate coverage entries.
 *   2. `guard-fail` (guarded transitions only): synthesized payload
 *      merged with `buildGuardPayloads.fail`. Guard rejects, state
 *      holds. Stamped with `guardCase: 'fail'` so observers
 *      (`assertPortalPerStep`, `assertCrudFlow`) skip it the same way
 *      they always have.
 *   3. `success`: synthesized full payload via `synthesizeSuccessPayload`.
 *      For guarded transitions the synth is merged with
 *      `buildGuardPayloads.pass` so the guard is satisfied AND the
 *      validator sees every required field. Stamped `guardCase: 'pass'`
 *      when guarded; null otherwise.
 *
 * Pre-v3.14 the unguarded path emitted a single `{}` step (which
 * accidentally exercised the validator's reject branch but never the
 * success branch for events with required payload fields). The guarded
 * path emitted pass+fail variants without payload-schema synthesis,
 * leaving guarded events with required payload fields dispatched on
 * payloads that the validator rejected even on the pass case.
 *
 * Pure. No browser, no I/O. Unit-testable with inline trait fixtures.
 *
 * @packageDocumentation
 */

import { buildGuardPayloads } from '@almadar/core';
import type { EntityFieldDef } from '../browser/interaction.js';
import type { ExtendedWalkStep, PayloadCase, PlanWalkInput } from './types.js';
import {
  hasRequiredPayloadFields,
  synthesizeSuccessPayload,
} from './internal/payload-synth.js';

export function planWalk(input: PlanWalkInput): ExtendedWalkStep[] {
  const { trait, includeAutoInit = true, entityFieldsByName = {} } = input;

  const result: ExtendedWalkStep[] = [];

  if (includeAutoInit) {
    result.push(makeAutoInitStep(trait.traitName, trait.initialState));
  }

  for (const transition of trait.transitions) {
    if (transition.event === 'INIT' && transition.from === trait.initialState) continue;

    const eventDecl = trait.events?.find((e) => e.key === transition.event);
    const payloadSchema = eventDecl?.payloadSchema;
    const successPayload = synthesizeSuccessPayload(
      payloadSchema,
      trait.linkedEntity,
      entityFieldsByName,
    );
    const emitMalformed = hasRequiredPayloadFields(payloadSchema);

    if (transition.hasGuard) {
      // Guarded transitions get pass + fail guard variants. The guard
      // payload is merged with the synthesized success payload so the
      // dispatch satisfies both the guard AND the API validator's
      // required-field check.
      const guardPayloads = transition.guard !== undefined
        ? buildGuardPayloads(transition.guard)
        : { pass: {}, fail: {} };

      if (emitMalformed) {
        result.push(makeStep({
          trait,
          transition,
          guardCase: null,
          payloadCase: 'malformed',
          payload: {},
          entityFieldsByName,
        }));
      }

      result.push(makeStep({
        trait,
        transition,
        guardCase: 'pass',
        payloadCase: 'success',
        payload: { ...successPayload, ...guardPayloads.pass },
        entityFieldsByName,
      }));

      result.push(makeStep({
        trait,
        transition,
        guardCase: 'fail',
        payloadCase: 'guard-fail',
        payload: { ...successPayload, ...guardPayloads.fail },
        entityFieldsByName,
      }));
      continue;
    }

    if (emitMalformed) {
      result.push(makeStep({
        trait,
        transition,
        guardCase: null,
        payloadCase: 'malformed',
        payload: {},
        entityFieldsByName,
      }));
    }

    result.push(makeStep({
      trait,
      transition,
      guardCase: null,
      payloadCase: 'success',
      payload: successPayload,
      entityFieldsByName,
    }));
  }

  return result;
}

interface MakeStepInput {
  trait: PlanWalkInput['trait'];
  transition: PlanWalkInput['trait']['transitions'][number];
  guardCase: 'pass' | 'fail' | null;
  payloadCase: PayloadCase;
  payload: Record<string, unknown>;
  entityFieldsByName: Record<string, EntityFieldDef[]>;
}

function makeStep(input: MakeStepInput): ExtendedWalkStep {
  const { trait, transition, guardCase, payloadCase, payload } = input;
  return {
    from: transition.from,
    event: transition.event,
    to: transition.to,
    guardCase,
    payload,
    isRepositioning: false,
    traitName: trait.traitName,
    triggerKind: 'bus',
    coverageKey: buildCoverageKey(trait.traitName, transition.from, transition.event, transition.to, guardCase, payloadCase),
    payloadCase,
  };
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
    coverageKey: buildCoverageKey(traitName, initialState, 'INIT', initialState, null, null),
  };
}

/**
 * Build the canonical coverage key. Format mirrors `frame/keyOf(cause)`:
 *   `${trait}:${from}+${event}->${to}` (unguarded, no payload variant)
 *   `${trait}:${from}+${event}->${to}[<variant>]` (guarded or variant-tagged)
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
  payloadCase: PayloadCase | null,
): string {
  const base = `${traitName}:${from}+${event}->${to}`;
  // Variant suffix priority: payloadCase wins (it's the more specific
  // tag). Guarded transitions emit guardCase + payloadCase (pass+success,
  // fail+guard-fail) — using payloadCase keeps the suffix unambiguous.
  if (payloadCase !== null) return `${base}[${payloadCase}]`;
  if (guardCase !== null) return `${base}[${guardCase}]`;
  return base;
}
