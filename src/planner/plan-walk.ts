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
 * Guarded variants whose guard binds `@entity.*` / `@config.*` (not
 * `@payload.*`) are stamped `guardSteerable: false` — the payload can't
 * steer the outcome, so `assertGuardParity` skips them instead of
 * flagging divergences the planner can't control.
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

import { buildGuardPayloads, collectBindings, constTruth, type EventPayload, type SExpr } from '@almadar/core';
import type { EntityFieldDef } from '../browser/interaction.js';
import type { ExtendedWalkStep, PayloadCase, PlanWalkInput } from './types.js';
import {
  hasRequiredPayloadFields,
  synthesizeSuccessPayload,
} from './internal/payload-synth.js';
import { transientClosure } from './internal/transient-closure.js';

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

      // A post-inline constant-folded guard (e.g. `(or (= "create" "create")
      // @payload.row)` for a create-mode modal) is always true / always false:
      // it has no fail / no pass case. Emitting the impossible variant would
      // dispatch a payload the runtime ignores and then flag a spurious
      // guard-parity divergence. `constTruth` returns the constant value, or
      // null when a binding remains (then both variants are real).
      const constant = transition.guard !== undefined ? constTruth(transition.guard) : null;
      const canFail = constant !== true;
      const canPass = constant !== false;

      // Guards bound to `@entity.*` / `@config.*` (not `@payload.*`)
      // synthesize `{pass:{},fail:{}}` — the payload cannot steer the
      // outcome, so `assertGuardParity` would flag divergences it has no
      // control over. Mark the variants unsteerable so the observer
      // skips them instead.
      const steerable = transition.guard === undefined || guardIsPayloadSteerable(transition.guard);

      // malformed expects the validator to reject; pointless when the guard
      // always passes (the success path is the only meaningful one).
      if (emitMalformed && canFail) {
        result.push(makeStep({
          trait,
          transition,
          guardCase: null,
          payloadCase: 'malformed',
          payload: {},
          entityFieldsByName,
        }));
      }

      if (canPass) {
        result.push(makeStep({
          trait,
          transition,
          guardCase: 'pass',
          payloadCase: 'success',
          payload: { ...successPayload, ...guardPayloads.pass } as EventPayload,
          entityFieldsByName,
          guardSteerable: steerable,
        }));
      }

      if (canFail) {
        result.push(makeStep({
          trait,
          transition,
          guardCase: 'fail',
          payloadCase: 'guard-fail',
          payload: { ...successPayload, ...guardPayloads.fail } as EventPayload,
          entityFieldsByName,
          guardSteerable: steerable,
        }));
      }
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
  payload: EventPayload;
  entityFieldsByName: Record<string, EntityFieldDef[]>;
  guardSteerable?: boolean;
}

function makeStep(input: MakeStepInput): ExtendedWalkStep {
  const { trait, transition, guardCase, payloadCase, payload } = input;
  const step: ExtendedWalkStep = {
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
    ...(input.guardSteerable !== undefined && { guardSteerable: input.guardSteerable }),
    ...(transition.navigates === true && { navigates: true }),
  };
  // Complementary guarded arms on the same (from, event): a guard-fail probe
  // for THIS arm may legitimately fire a SIBLING arm (std-ml-similarity's
  // `COMPARE -> embedding when (> len 0)` / `COMPARE -> resolved when (== len 0)`).
  // Landing on a sibling's target is the guard system working, not a
  // divergence — record the siblings so `decideAccepted` can credit it.
  if (guardCase === 'fail') {
    const siblings = trait.transitions
      .filter((t) => t.from === transition.from && t.event === transition.event && t.to !== transition.to)
      .map((t) => t.to);
    if (siblings.length > 0) step.guardSiblingTargets = siblings;
  }
  // Acceptance closures (forward / guard-pass / success variants only; the
  // guard-fail / malformed variants expect the state to HOLD).
  if (guardCase !== 'fail' && payloadCase !== 'malformed') {
    const emitted = trait.effectEmittedEvents;
    if (emitted !== undefined && emitted.has(transition.event)) {
      // The event is fired by an EFFECT's outcome (a fetch's
      // success/failure callback), not by the user. The manual dispatch is a
      // no-op nudge — the runtime is wherever the natural effect flow settled,
      // which is somewhere in `from`'s transient closure. With mock data the
      // success branch wins, so the failure target (e.g. `error`) is only
      // reachable via failure injection; credit any natural settled state
      // rather than hard-failing the undrivable branch.
      const closure = transientClosure(transition.from, trait);
      if (closure.length > 1) step.acceptStates = closure;
    } else {
      // When `to` auto-advances via effect-emitted events, the runtime settles
      // past it before the kernel observes — credit any state in the closure.
      const closure = transientClosure(transition.to, trait);
      if (closure.length > 1) step.acceptStates = closure;
    }
  }
  return step;
}

/**
 * A guard is payload-steerable iff every binding it references is a
 * `@payload.*` field — the only inputs `buildGuardPayloads` can control.
 * A guard that also binds `@entity.*` / `@config.*` (snake's
 * `(and (not @entity.over) (!= @entity.dir "down"))`) decides partly on
 * runtime state the dispatch payload cannot reach, so the pass/fail
 * prediction is not the planner's to make.
 *
 * A guard with ZERO bindings is a fully const-folded literal — e.g. a
 * standalone-verified `when @config.enabled` (default `false`, no
 * override in scope) resolves at `orbital resolve` time to the literal
 * `guard: false`, not a string/array `@config.*` reference. `.every()`
 * on `collectBindings(guard) === []` is vacuously `true`, which read as
 * "steerable" — exactly backwards: a constant has nothing left for the
 * payload to move, so it's the least steerable case there is, not the
 * most. Every lowered form of a config-only guard (bare-atom string,
 * `["=", ...]` array, or fully-folded literal) must land here as
 * unsteerable.
 */
function guardIsPayloadSteerable(guard: SExpr): boolean {
  const bindings = collectBindings(guard);
  if (bindings.length === 0) return false;
  return bindings.every((b) => b.startsWith('@payload'));
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
