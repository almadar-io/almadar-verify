/**
 * `probeListenCascades` — a LIVE runtime probe, not a Frame-stream observer.
 *
 * Every other file in `observer/` is a pure consumer of a precomputed
 * `Frame[]` stream (see the `Observer<T>` contract in `types.ts`). This one
 * is deliberately different: it drives a real `OrbitalServerRuntime`
 * instance directly (`processOrbitalEvent`) because the defect class it
 * exists to catch is invisible to everything else in the codebase's
 * verification ladder:
 *
 *   - `orb validate` / `orb verify` (the Rust engine) and `runtime-verify`'s
 *     own walk all DISPATCH DIRECTLY to each trait (`targetTrait: X`) — none
 *     of them ever exercise a `listens { Source.EVENT -> LOCAL }` route by
 *     making the SOURCE trait emit and watching the bus carry it to the
 *     LISTENER. A source-qualified cross-trait cascade can be silently
 *     broken in `OrbitalServerRuntime`'s bus-routing layer while every
 *     existing gate stays green, because every existing gate proves the
 *     LISTENER'S OWN transition is well-formed, never that the EMIT reaches
 *     it.
 *   - `lintWiring`'s `listens-source-never-emits` (`wiring-lint.ts`) is the
 *     static sibling of this probe's `listen-source-cannot-emit` finding —
 *     it proves the source trait CAN structurally produce the event. It
 *     cannot prove the emit is actually DELIVERED once produced: a listener
 *     with no `eventId` yet, subscribing under the bare event name while
 *     the emitter routes under a V4 ledger event-id key
 *     (`OrbitalServerRuntime.resolveSourceEmitEventId`), validates 0/0 and
 *     lints clean — the two ends of the wire are each individually
 *     well-formed; only the runtime's own bus-key computation diverges. See
 *     `packages/almadar-runtime/test/composed-trait-listen-eventid-routing.test.ts`
 *     for the regression this rung exists to generalize.
 *
 * Method: for every source-qualified `listens` entry (`ListenSource.kind !==
 * 'any'`) in the schema, find a transition on the declared source trait that
 * emits the listened-for event — a literal `(emit EVENT ...)` tuple anywhere
 * in the effect tree, OR a `fetch`/`persist` async-result `emit:{success,
 * failure}` option (the latter via `collectEffectEmittedEvents`, the same
 * helper `wiring-lint.ts`'s static checks use for that shape) — synthesize a
 * triggering payload with the SAME guard/payload synthesis every planner in
 * this package uses
 * (`buildGuardPayloads` from `@almadar/core`, `synthesizeSuccessPayload` from
 * `../planner/internal/payload-synth.js` — reused, not forked), dispatch it
 * straight at the source trait via `runtime.processOrbitalEvent`, then
 * assert two things: (a) the source trait actually emitted the event (the
 * dispatch's own `response.emittedEvents`) and (b) the listener reacted —
 * its `TraitState.lastEvent` landed on the listen's `triggers` event AND its
 * `TraitState` actually changed, observed via `runtime.getState` before and
 * after a settle wait (the cascade's own `processOrbitalEvent` call is
 * fire-and-forget from the emitting dispatch's point of view — `EventBus.emit`
 * invokes the async listener closure without awaiting it — so the probe
 * waits the same way the regression test does).
 *
 * Deterministic; no name tricks. Source resolution walks the resolved
 * schema's own `orbitals[].traits[]` by the exact name the runtime resolves
 * `ListenSource` against (`OrbitalServerRuntime.resolveSourceEmitEventId`'s
 * own lookup) — never a substring/heuristic match.
 *
 * @packageDocumentation
 */

import type { EventPayload, OrbitalSchema, SExpr, Trait, Transition } from '@almadar/core';
import { buildGuardPayloads, collectBindings, constTruth, isInlineTrait } from '@almadar/core';
import { normalizeEventKey, type TraitState } from '@almadar/runtime';
import type { OrbitalServerRuntime } from '@almadar/runtime/OrbitalServerRuntime';
import { collectEntityFields, synthesizeSuccessPayload } from '../planner/internal/payload-synth.js';
import { collectEffectEmittedEvents } from '../planner/internal/effect-emits.js';

export type CascadeProbeCheck = 'listen-cascade-not-delivered' | 'listen-source-cannot-emit';

export interface CascadeProbeFinding {
  check: CascadeProbeCheck;
  severity: 'error';
  /** Orbital declaring the LISTENING trait. */
  orbital: string;
  /** The listening trait. */
  trait: string;
  /** Orbital declaring the SOURCE trait (may differ for a `kind: 'orbital'` source). */
  sourceOrbital: string;
  sourceTrait: string;
  /** The event named in the `listens { Source EVENT -> triggers }` entry. */
  event: string;
  /** The local event the listen fires on the listening trait. */
  triggers: string;
  message: string;
  suggestion: string;
}

export interface CascadeProbeResult {
  /** Number of source-qualified listens actually dispatched against. */
  probed: number;
  findings: CascadeProbeFinding[];
  errors: number;
}

/** `TraitState` narrow of `OrbitalServerRuntime.getState`'s unioned return
 *  (`TraitState | Record<string, TraitState> | undefined` — the second
 *  member only arises when the `traitName` argument is omitted, which this
 *  probe never does). A real runtime-check, not a bare assertion: a
 *  `Record<string, TraitState>` has no `currentState` key of its own. */
function isTraitState(value: TraitState | Record<string, TraitState> | undefined): value is TraitState {
  return value !== undefined && typeof (value as { currentState?: unknown }).currentState === 'string';
}

function readTraitState(
  runtime: OrbitalServerRuntime,
  orbitalName: string,
  traitName: string,
): TraitState | undefined {
  const state = runtime.getState(orbitalName, traitName);
  return isTraitState(state) ? state : undefined;
}

/** Top-level literal `['emit', event, ...]` entries in a transition's own
 *  `effects[]` — mirrors `plugin-wiring-lint.ts`'s `firingTriggerEvents`
 *  exactly (deliberately NOT recursing into `if`/`atomic` sub-trees: an emit
 *  nested behind its OWN internal condition needs that condition satisfied
 *  too, which this probe cannot synthesize — see `transitionIsProbable`).
 *  `collectEffectEmittedEvents` (`planner/internal/effect-emits.ts`) covers
 *  the one shape this deliberately doesn't: a `fetch`/`persist`
 *  `emit:{success,failure}` OPTION object, whose emit fires from the
 *  effect's own outcome, not from a literal tuple. */
function transitionEmittedEvents(transition: Transition): Set<string> {
  const out = new Set<string>();
  for (const effect of transition.effects ?? []) {
    if (Array.isArray(effect) && effect[0] === 'emit' && typeof effect[1] === 'string' && effect[1].length > 0) {
      out.add(effect[1]);
    }
  }
  for (const event of collectEffectEmittedEvents([transition])) out.add(event);
  return out;
}

/** A guard this probe can deterministically satisfy: none at all, a
 *  post-inline constant `true`, or one whose every binding is a
 *  `@payload.*` field (`buildGuardPayloads` can steer it). Same contract as
 *  `plan-walk.ts`'s file-local `guardIsPayloadSteerable` — a guard bound to
 *  `@entity.*`/`@config.*` (accumulated multi-dispatch state the probe's
 *  single synthesized dispatch cannot reach, e.g. vim-mode's Ex-command
 *  guard on `@entity.cmdline`) is NOT this probe's to predict. Returns
 *  `false` for a constant-`false` guard too — that arm can never fire. */
function transitionIsProbable(guard: SExpr | null | undefined): boolean {
  if (guard === undefined || guard === null) return true;
  const truth = constTruth(guard);
  if (truth !== null) return truth;
  const bindings = collectBindings(guard);
  return bindings.length > 0 && bindings.every((b) => b.startsWith('@payload'));
}

/** `"@payload.<field>"` → `<field>`, the one `payloadMapping` value shape
 *  this probe can invert. Anything else (a literal, an operator list) is
 *  left alone — the probe has no general inverse for an arbitrary
 *  expression, so a listener guard reachable only through one is out of
 *  reach, same as an unsteerable guard. */
function directPayloadRefField(expr: SExpr | undefined): string | undefined {
  if (typeof expr !== 'string') return undefined;
  const m = /^@payload\.([A-Za-z0-9_]+)$/.exec(expr);
  return m?.[1];
}

/**
 * Given the payload a LISTENER's own transition needs to pass ITS guard
 * (`buildGuardPayloads(listenerTransition.guard).pass`, keyed by the
 * listener's own field names — i.e. the `listens { with {...} }` mapping's
 * TARGET names), derive the SOURCE-side dispatch fields that would produce
 * it once the runtime applies `listen.payloadMapping`
 * (`applyListenPayloadMapping` — "the mapping REPLACES the payload: only
 * mapped keys survive", `@almadar/core`'s `listen-payload-mapping.ts`).
 *
 * No mapping declared → the raw emit payload passes straight through, so
 * the listener's field name IS the source's field name. A mapping present
 * but not a direct `@payload.<field>` passthrough for some required field
 * (a literal, an evaluated expression) has no general inverse — returns
 * `undefined` for the WHOLE derivation rather than a partial one, since a
 * partially-satisfied guard is still a guard-fail, not a probe result worth
 * trusting.
 */
function deriveSourceOverride(
  listenerGuardPass: EventPayload,
  payloadMapping: Record<string, SExpr> | undefined,
): EventPayload | undefined {
  const out: EventPayload = {};
  for (const [targetField, value] of Object.entries(listenerGuardPass)) {
    if (payloadMapping === undefined) {
      out[targetField] = value;
      continue;
    }
    const sourceField = directPayloadRefField(payloadMapping[targetField]);
    if (sourceField === undefined) return undefined;
    out[sourceField] = value;
  }
  return out;
}

/** Every inline trait declared on `orb`, keyed by name. Ref stubs (unresolved
 *  `uses` imports) are skipped — same contract as `plugin-wiring-lint.ts`'s
 *  `inlineTraitsOf`: the probe needs a real `stateMachine` to find an
 *  emitting arm and a real runtime registration to dispatch against. */
function inlineTraits(traits: OrbitalSchema['orbitals'][number]['traits']): Map<string, Trait> {
  const out = new Map<string, Trait>();
  for (const ref of traits ?? []) {
    if (isInlineTrait(ref)) out.set(ref.name, ref);
  }
  return out;
}

export async function probeListenCascades(
  runtime: OrbitalServerRuntime,
  schema: OrbitalSchema,
): Promise<CascadeProbeResult> {
  const findings: CascadeProbeFinding[] = [];
  let probed = 0;
  const entityFieldsByName = collectEntityFields(schema);

  for (const orb of schema.orbitals) {
    const listenerTraits = inlineTraits(orb.traits);

    for (const [listenerName, listener] of listenerTraits) {
      for (const listen of listener.listens ?? []) {
        const source = listen.source;
        // No single resolvable emitter to probe: `kind: 'any'` is a
        // wildcard subscription (every trait, every orbital) and `undefined`
        // is a local payload declaration with no bus subscription at all.
        if (source === undefined || source.kind === 'any') continue;

        const sourceOrbitalName = source.kind === 'orbital' ? source.orbital : orb.name;
        const sourceOrb = schema.orbitals.find((o) => o.name === sourceOrbitalName);
        const sourceTrait = sourceOrb === undefined ? undefined : inlineTraits(sourceOrb.traits).get(source.trait);
        if (sourceOrb === undefined || sourceTrait === undefined) {
          // Dangling source — `lintWiring`'s `listens-source-never-emits`
          // (single-orbital) and `lintPluginWiring`'s
          // `plugin-listen-source-not-host` (cross-registry) already report
          // this statically; there is nothing live to dispatch against.
          continue;
        }

        // Every transition on the source trait that produces `listen.event`
        // at all (structural — no reachability/state filter yet). Empty
        // means the route is dead full stop, the one case this probe
        // reports as `listen-source-cannot-emit` unconditionally.
        const emittingTransitions = (sourceTrait.stateMachine?.transitions ?? []).filter((t) =>
          transitionEmittedEvents(t).has(listen.event),
        );

        if (emittingTransitions.length === 0) {
          probed++;
          findings.push({
            check: 'listen-source-cannot-emit',
            severity: 'error',
            orbital: orb.name,
            trait: listenerName,
            sourceOrbital: sourceOrbitalName,
            sourceTrait: source.trait,
            event: listen.event,
            triggers: listen.triggers,
            message:
              `${listenerName} listens for ${source.trait}.${listen.event} -> ${listen.triggers}, but no ` +
              `transition on ${source.trait} emits ${listen.event}`,
            suggestion:
              `add an ['emit', '${listen.event}', ...] effect to the transition on ${source.trait} that should ` +
              `produce it, or rewire the listen to the trait that actually emits ${listen.event}`,
          });
          continue;
        }

        // Reachable from the source trait's CURRENT live state (an earlier
        // probed listen in this same run may have already moved it) AND a
        // guard this probe can actually satisfy (`transitionIsProbable`) —
        // dispatching an unreachable/unsteerable arm is a silent no-op (or
        // an unpredictable one) that would misreport a probe-methodology
        // gap as a live wiring bug.
        const liveState = readTraitState(runtime, sourceOrbitalName, source.trait);
        const transition = emittingTransitions.find(
          (t) => t.from === liveState?.currentState && transitionIsProbable(t.guard),
        );
        if (transition === undefined) {
          // The route structurally exists but this run cannot deterministically
          // exercise it from the trait's current live state (unreachable this
          // hop, or every reachable arm's guard depends on accumulated
          // `@entity.*`/`@config.*` state a single synthesized dispatch can't
          // set) — not a claim the route is broken, so no finding.
          continue;
        }

        // The LISTENER's own reachable transition(s) for `triggers`, read
        // BEFORE dispatching (the cascade hasn't happened yet). If none are
        // reachable from the listener's live state, or every reachable one's
        // guard depends on something this probe cannot steer into the
        // dispatch (see `deriveSourceOverride`), delivery can't be asserted
        // either way this run — skip rather than guess.
        const listenerBefore = readTraitState(runtime, orb.name, listenerName);
        const listenerCandidates = (listener.stateMachine?.transitions ?? []).filter(
          (t) => t.event === listen.triggers && t.from === listenerBefore?.currentState,
        );
        if (listenerCandidates.length === 0) continue;

        const unconditional = listenerCandidates.find(
          (t) => t.guard === undefined || t.guard === null || constTruth(t.guard) === true,
        );
        let sourceOverride: EventPayload = {};
        if (unconditional === undefined) {
          const guardedCandidate = listenerCandidates.find(
            (t) => t.guard !== undefined && t.guard !== null && transitionIsProbable(t.guard),
          );
          if (guardedCandidate === undefined) continue;
          const listenerGuardPass = buildGuardPayloads(guardedCandidate.guard).pass;
          const derived = deriveSourceOverride(listenerGuardPass, listen.payloadMapping);
          if (derived === undefined) continue;
          sourceOverride = derived;
        }

        probed++;

        const eventDecl = sourceTrait.stateMachine?.events?.find((e) => e.key === transition.event);
        const successPayload = synthesizeSuccessPayload(
          eventDecl?.payloadSchema,
          sourceTrait.linkedEntity,
          entityFieldsByName,
        );
        const guardPayload =
          transition.guard !== undefined && transition.guard !== null && constTruth(transition.guard) === null
            ? buildGuardPayloads(transition.guard).pass
            : {};
        // `sourceOverride` wins: it encodes what the LISTENER's own guard
        // requires, the field this probe most needs correct to prove
        // delivery — the source's own synthesis has no way to know that
        // requirement.
        const payload: EventPayload = { ...successPayload, ...guardPayload, ...sourceOverride };

        const response = await runtime.processOrbitalEvent(sourceOrbitalName, {
          event: transition.event,
          payload,
          targetTrait: source.trait,
        });

        const sourceEmitted = response.success && response.emittedEvents.some((e) => e.event === listen.event);
        if (!sourceEmitted) {
          // The chosen arm didn't fire from the trait's live state this run
          // (payload validation failed, or a supposedly-steerable guard
          // still rejected the synthesized payload) — structurally the same
          // "the probe found nothing to exercise" gap as the
          // empty-emittingTransitions case above.
          findings.push({
            check: 'listen-source-cannot-emit',
            severity: 'error',
            orbital: orb.name,
            trait: listenerName,
            sourceOrbital: sourceOrbitalName,
            sourceTrait: source.trait,
            event: listen.event,
            triggers: listen.triggers,
            message:
              `${listenerName} listens for ${source.trait}.${listen.event} -> ${listen.triggers}; probed ` +
              `${source.trait}.${transition.event} from state '${liveState?.currentState ?? 'unknown'}' but it ` +
              `did not emit ${listen.event}${response.error ? ` (${response.error})` : ' (guard rejected the synthesized payload)'}`,
            suggestion:
              `verify the guard/state preconditions for the arm on ${source.trait} that should emit ` +
              `${listen.event}, or drive it into the reachable state before relying on this cascade`,
          });
          continue;
        }

        // `EventBus.emit` invokes `setupEventListeners`'s async handler
        // fire-and-forget — the emitting `processOrbitalEvent` call above
        // never awaits the listener's own cascade dispatch. Give it a
        // settle tick, matching
        // `composed-trait-listen-eventid-routing.test.ts`'s own wait.
        await new Promise((r) => setTimeout(r, 20));

        const listenerAfter = readTraitState(runtime, orb.name, listenerName);
        const normalizedTriggers = normalizeEventKey(listen.triggers);
        // Object-IDENTITY change, not a value comparison: `sendEvent` always
        // stores a brand-new `TraitState` object on every EXECUTED transition
        // (`StateMachineManager`'s `states.set(key, {...traitState, ...})`),
        // even when the new values happen to equal the old ones — a listener
        // whose own arm is a guardless self-transition (`from === to`, no
        // state-changing effect) can legitimately have already landed on the
        // SAME `(currentState, lastEvent)` pair from an earlier, unrelated
        // probe in this same run (a coincidental side-channel: two different
        // listens on this schema can share a downstream cascade target). A
        // value comparison would then read that as "nothing happened" on
        // this dispatch and misreport a working cascade as broken; reference
        // inequality catches the second execution regardless.
        const delivered =
          listenerAfter !== undefined &&
          listenerAfter !== listenerBefore &&
          listenerAfter.lastEvent === normalizedTriggers;

        if (!delivered) {
          findings.push({
            check: 'listen-cascade-not-delivered',
            severity: 'error',
            orbital: orb.name,
            trait: listenerName,
            sourceOrbital: sourceOrbitalName,
            sourceTrait: source.trait,
            event: listen.event,
            triggers: listen.triggers,
            message:
              `${source.trait} emitted ${listen.event} (confirmed via processOrbitalEvent.emittedEvents) but ` +
              `${listenerName}'s ${listen.triggers} listen never fired — the bus route from ${source.trait}.` +
              `${listen.event} to ${listenerName} is broken`,
            suggestion:
              `check the runtime's bus routing key for this listen — a listener with no eventId must resolve ` +
              `the SAME id the emitter stamps (OrbitalServerRuntime.resolveSourceEmitEventId) rather than ` +
              `subscribing under the bare event name`,
          });
        }
      }
    }
  }

  return { probed, findings, errors: findings.length };
}
