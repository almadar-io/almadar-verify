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
 *   - the compiler's `ORB_X_LISTEN_SOURCE_UNRESOLVED` (the JS static lint's
 *     `listens-source-never-emits` duplicated this and was retired
 *     2026-09-12) is the static sibling of this probe's
 *     `listen-source-cannot-emit` finding — it proves the source trait CAN
 *     structurally produce the event. It
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
 * helper `event-producers.ts`'s walkers use for that shape) — synthesize a
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

import type { EntityRow, EventPayload, EventPayloadValue, OrbitalSchema, SExpr, Trait, Transition } from '@almadar/core';
import { buildGuardPayloads, collectBindings, constTruth, isInlineTrait } from '@almadar/core';
import {
  entityAccessPolicies,
  identityEntitiesOf,
  ownerFieldsFromSchema,
  roleSatisfyingPolicy,
} from '@almadar/core/mock';
import { normalizeEventKey, type InMemoryPersistence, type TraitState } from '@almadar/runtime';
import type { OrbitalServerRuntime } from '@almadar/runtime/OrbitalServerRuntime';
import { collectEntityFields, synthesizeSuccessPayload } from '../planner/internal/payload-synth.js';
import { collectEffectEmittedEvents } from '../planner/internal/effect-emits.js';
import { findPersistKind, findPersistWholeRowField } from '../planner/internal/persist-binding.js';
import { crossEntityRestrictRelations, pickTargetRow, selfRelationFieldNames } from '../planner/internal/self-relation-fields.js';
import { producibleEvents } from './event-producers.js';
import { embedHostChain, embedHostsOf } from './click-wiring-audit.js';
import { declaredEntityRow } from '../driver/declared-entity-row.js';
import { resolveTraitNames } from '../planner/trait-scope.js';

/**
 * Stable id for the ONE row seeded into a source trait's `linkedEntity`
 * before each probed dispatch — mirrors the Rust planner's own seed id
 * EXACTLY (`orbital-verify/src/planner.rs` `seed_row_id`,
 * `format!("{linked_entity}-verify-seed-1")`) so a by-id fetch this probe
 * triggers (e.g. `std-record-detail`'s `INIT -> loading (fetch RecordItem {
 * id: ?id })`) hits a REAL row instead of missing on a faker id nothing
 * ever created (`EffectExecutor`'s by-id-miss fix turns that miss into a
 * FAILURE event, so a missed fetch no longer even emits the SUCCESS event
 * this probe is trying to prove cascades correctly).
 */
function seedRowId(linkedEntity: string): string {
  return `${linkedEntity}-verify-seed-1`;
}

/** `entityName`'s own owner column NAMES (bare, not `Entity.field`-qualified)
 *  from `ownerFieldsFromSchema`'s schema-wide list — the JS mirror of the
 *  Rust planner's `stamp_owner`. Without stamping these, a seeded row fails
 *  every owner-scoped `@read` policy arm unconditionally (`authorId == ""`
 *  never matches a real viewer id), so `applyRowAccess` filters the row out
 *  and the by-id fetch reports "not found" even though the row exists. */
function ownerFieldNames(schema: OrbitalSchema, entityName: string): string[] {
  const prefix = `${entityName}.`;
  return ownerFieldsFromSchema(schema)
    .filter((pair) => pair.startsWith(prefix))
    .map((pair) => pair.slice(prefix.length));
}

/**
 * The id a seeded `entityName` row (and the dispatch payload's own `id`,
 * which must name the SAME row) should carry. For a self-identity entity —
 * `ownerFieldNames` includes `"id"` (`ownerFieldsFromSchema`'s self-identity
 * arm: an `@entity.id == @user.id` access policy) — the row's id IS the
 * owner column, so it must equal the current viewer's id or every
 * self-scoped policy filters the seed out; every other entity keeps the
 * synthetic `seedRowId`, which the current viewer never coincidentally
 * matches.
 */
function effectiveSeedId(
  schema: OrbitalSchema,
  runtime: OrbitalServerRuntime,
  entityName: string,
): string {
  const viewerId = runtime.getDefaultUser()?.id;
  if (viewerId !== undefined && ownerFieldNames(schema, entityName).includes('id')) {
    return viewerId;
  }
  return seedRowId(entityName);
}

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

/** Every inline trait in the whole schema, keyed by name — the lookup
 *  `embedHostChain`'s host NAMES need resolved back to a `Trait` so
 *  `producibleEvents` can be asked whether an embedding host produces the
 *  listened-for event (embedded chrome emits under its embedder's scope,
 *  same contract `click-wiring-audit.ts`'s own audit already credits). */
function allInlineTraitsByName(schema: OrbitalSchema): Map<string, Trait> {
  const out = new Map<string, Trait>();
  for (const orb of schema.orbitals) {
    for (const [name, trait] of inlineTraits(orb.traits)) {
      if (!out.has(name)) out.set(name, trait);
    }
  }
  return out;
}

/** True when `sourceTrait` (or an embedding host up its chain) can
 *  structurally produce `event` by ANY declared mechanism —
 *  `producibleEvents`'s full oracle (emits[]/effect-emit/registry
 *  event-outlet prop/config item-action descriptor).
 *  This is deliberately broader than {@link transitionEmittedEvents}: a
 *  render-action or config-item-action affordance is a real, declared
 *  producer a user can click, but its click routes through the CLIENT's own
 *  bus (`useTraitStateMachine`'s `UI:Orbital.Trait.EVENT` wiring), never
 *  through `OrbitalServerRuntime`'s server-side `eventBus` this headless
 *  probe drives — `emittedEvents` is populated only by the `emit` handler
 *  inside `executeEffects` (a literal `emit` effect or a fetch/persist
 *  success|failure option). So structural producibility can be TRUE while
 *  this probe still cannot dispatch-and-observe delivery; that split is
 *  exactly why this function gates the unconditional "cannot produce"
 *  finding while `transitionEmittedEvents` (unchanged) keeps gating what
 *  this probe actually dispatches.
 *
 *  `producible` defaults to the full {@link producibleEvents} oracle (this
 *  probe's own use); the parameter stays open for a caller needing a
 *  narrower LIVE-only oracle to reuse this same embed-host-chain walk
 *  instead of forking it. */
export function traitOrEmbedHostProduces(
  sourceTrait: Trait,
  sourceTraitName: string,
  event: string,
  embedHosts: ReadonlyMap<string, string>,
  traitsByName: ReadonlyMap<string, Trait>,
  producible: (trait: Trait) => Set<string> = producibleEvents,
): boolean {
  if (producible(sourceTrait).has(event)) return true;
  // A trait embedded (directly or transitively) INSIDE `sourceTraitName`
  // emits under ITS EMBEDDER's scope — embedded chrome routes through its
  // host, the exact contract `click-wiring-audit.ts`'s own audit credits
  // (`hostHandler`). The canonical shape: a JSX inline `<Trait.traits.X
  // action={E} />` embed lowers to a compiler-generated `InlineButtonRenderN`
  // CHILD trait carrying `action: E` in ITS OWN render tree — the host's own
  // tree only holds an opaque `@trait.InlineButtonRenderN` reference, so
  // `producibleEvents(sourceTrait)` alone never sees `E`. Find that child by
  // walking every other trait's OWN host chain for one that passes through
  // `sourceTraitName`.
  for (const [childName, childTrait] of traitsByName) {
    if (childName === sourceTraitName) continue;
    if (!embedHostChain(childName, embedHosts).includes(sourceTraitName)) continue;
    if (producible(childTrait).has(event)) return true;
  }
  return false;
}

/** Narrows a payload value to a plain `EventPayload` object — excludes
 *  `null`/`undefined`, an array (`readonly EventPayloadValue[]` is a sibling
 *  union member, not an object to patch fields onto), and `Date` (also
 *  `typeof … === 'object'`, but has no fields of its own to spread). Used to
 *  safely spread-and-patch a whole-row payload field's CURRENT value rather
 *  than assume its shape. */
function isPlainEventPayload(value: EventPayloadValue): value is EventPayload {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

export async function probeListenCascades(
  runtime: OrbitalServerRuntime,
  schema: OrbitalSchema,
  /** When supplied, seed one real row per source trait's `linkedEntity`
   *  before each probed dispatch (see `seedRowId`) so a by-id fetch the
   *  dispatch triggers hits real data instead of missing on a synthesized
   *  id nothing was ever created for. Omitted → unchanged behavior (a
   *  by-id fetch inside the probed dispatch will miss). */
  persistence?: InMemoryPersistence,
  /**
   * `--trait` scope (owner ruling 2026-09-11: verification is one trait
   * at a time). When supplied, only listens routes whose LISTENER (target)
   * OR SOURCE trait resolves into this set are probed — a scoped trait's
   * cascades still get probed even when the counterpart end's own walk is
   * skipped. Accepts either spelling a trait can carry post-resolve (see
   * `resolveTraitNames`); a name matching no trait in `schema` throws,
   * listing every available trait name. Undefined/empty → every
   * source-qualified listen is probed (today's behavior).
   */
  traits?: readonly string[],
): Promise<CascadeProbeResult> {
  const traitScope = traits !== undefined && traits.length > 0
    ? new Set(resolveTraitNames(schema, traits))
    : null;
  const findings: CascadeProbeFinding[] = [];
  let probed = 0;
  const entityFieldsByName = collectEntityFields(schema);
  const embedHosts = embedHostsOf(schema);
  const traitsByName = allInlineTraitsByName(schema);

  for (const orb of schema.orbitals) {
    const listenerTraits = inlineTraits(orb.traits);

    for (const [listenerName, listener] of listenerTraits) {
      for (const listen of listener.listens ?? []) {
        const source = listen.source;
        // No single resolvable emitter to probe: `kind: 'any'` is a
        // wildcard subscription (every trait, every orbital) and `undefined`
        // is a local payload declaration with no bus subscription at all.
        if (source === undefined || source.kind === 'any') continue;

        // `--trait` scope: probe only when the LISTENER (target) or the
        // SOURCE trait is named — a scoped trait's cascades are probed on
        // either end, even when the counterpart's own walk was skipped.
        if (traitScope !== null && !traitScope.has(listenerName) && !traitScope.has(source.trait)) continue;

        const sourceOrbitalName = source.kind === 'orbital' ? source.orbital : orb.name;
        const sourceOrb = schema.orbitals.find((o) => o.name === sourceOrbitalName);
        const sourceTrait = sourceOrb === undefined ? undefined : inlineTraits(sourceOrb.traits).get(source.trait);
        if (sourceOrb === undefined || sourceTrait === undefined) {
          // Dangling source — the compiler's `ORB_X_LISTEN_SOURCE_UNRESOLVED`
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
          // Not "no literal emit exists", but "cannot produce E AT ALL":
          // `producibleEvents` also credits a registry event-outlet prop
          // (`searchEvent`/`action`) and a config item-action descriptor
          // (`itemActions`/`browseItemActions`/…) — both real, declared,
          // user-clickable producers this probe simply cannot dispatch and
          // observe server-side (see `traitOrEmbedHostProduces`'s doc). An
          // embedding host up the chain producing it also counts: embedded
          // chrome emits under its embedder's scope, same as
          // `click-wiring-audit.ts`'s own audit credits.
          if (traitOrEmbedHostProduces(sourceTrait, source.trait, listen.event, embedHosts, traitsByName)) continue;

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

        // A source transition that PERSISTS is access-gated by the target
        // entity's declared `@create`/`@update`/`@delete` policy for that
        // action. A role-only policy (`std-time-tracking`'s `Employee
        // @create ["=", @user.role, "approver"]`, `TimeEntry @create (or
        // ["=", @user.role, "employee"] ["=", @user.role, "approver"])`)
        // unconditionally rejects the probe's own default viewer — its
        // `role` is deliberately empty (`DEFAULT_VIEWER`'s doc,
        // `@almadar/core`) — so the persist is denied, no success event
        // fires, and the honest `persist:denied` (post-B4-V3) surfaces here
        // as a false `listen-source-cannot-emit`, not as the access-control
        // finding it actually is. Derive a viewer role FROM THE POLICY
        // ITSELF (`roleSatisfyingPolicy`: literals the policy actually
        // compares against `@user.role`, intersected with the identity
        // entity's own declared `role` vocabulary — never a guess) and
        // switch to it for exactly this dispatch. `undefined` back means
        // either "no role restriction" (nothing to fix) or "no roster role
        // can ever satisfy this policy" — both cases leave the viewer
        // untouched and let the existing findings below report honestly;
        // this never forces a transition green.
        const persistTarget = findPersistKind(transition.effects ?? []);
        const originalUser = runtime.getDefaultUser();
        let roleSwitched = false;
        if (persistTarget !== null && originalUser !== undefined) {
          const policy = entityAccessPolicies(schema, persistTarget.entity)?.[persistTarget.kind];
          const identity = identityEntitiesOf(schema.orbitals ?? [])[0];
          const role = identity === undefined ? undefined : roleSatisfyingPolicy(policy, identity);
          if (role !== undefined && role !== originalUser.role) {
            runtime.setDefaultUser({ ...originalUser, role });
            roleSwitched = true;
          }
        }

        try {
          // Seed ONE real row for the source trait's `linkedEntity` before
          // dispatching, so a by-id fetch this dispatch triggers (e.g.
          // `std-record-detail`'s `INIT -> loading (fetch RecordItem { id:
          // ?id })`) hits real data instead of missing on the synthesized id
          // below — a miss now emits FAILURE (`EffectExecutor`'s by-id-miss
          // fix), never the SUCCESS event this probe is trying to observe.
          // Owner columns are stamped with the runtime's own default viewer:
          // `OrbitalServerRuntime`'s fetch handler ANDs every by-id read with
          // the entity's declared `@read` policy (`applyRowAccess`) — an
          // owner-scoped policy filters out a row whose owner column doesn't
          // match the CURRENT viewer, so an unstamped seed row still reports
          // "not found" even though it exists in the store.
          const viewerId = runtime.getDefaultUser()?.id;
          if (persistence !== undefined && sourceTrait.linkedEntity !== undefined) {
            const linkedEntity = sourceTrait.linkedEntity;
            const overrides: EntityRow = { id: effectiveSeedId(schema, runtime, linkedEntity) };
            if (viewerId !== undefined) {
              for (const field of ownerFieldNames(schema, linkedEntity)) {
                // `id` is already set above (to the viewer's id for a
                // self-identity entity, else the synthetic seed id) — never
                // overwrite a non-self-identity entity's synthetic id here.
                if (field === 'id') continue;
                overrides[field] = viewerId;
              }
            }
            const row = declaredEntityRow(schema, linkedEntity, overrides);
            await persistence.seed({ [linkedEntity]: [row] });
          }

          // C1-V19 (item 5b): a `persist delete` target must pick a row the
          // runtime's own `onDelete: restrict` rules won't already block —
          // this probe shares ONE persistence store across every listen in
          // the whole schema, so an earlier iteration's seeded row on a
          // DIFFERENT entity can legitimately reference the row this
          // dispatch is about to try to delete. A fixed synthetic id (the
          // pre-existing `effectiveSeedId` behavior) has no way to notice
          // that — the resulting `denied` read as a broken cascade instead
          // of the honest "no deletable row exists yet" case. Reuse item 3's
          // OWN picker (`pickTargetRow` + `inboundRestrictRelations`'s self/
          // cross-entity slices) against the LIVE store instead of guessing.
          let deleteTargetId: string | undefined;
          if (persistTarget !== null && persistTarget.kind === 'delete' && persistence !== undefined) {
            const entityRows = await persistence.list(persistTarget.entity);
            if (entityRows.length === 0) {
              const seeded = declaredEntityRow(schema, persistTarget.entity, {
                id: effectiveSeedId(schema, runtime, persistTarget.entity),
              });
              await persistence.seed({ [persistTarget.entity]: [seeded] });
              deleteTargetId = typeof seeded['id'] === 'string' ? seeded['id'] : undefined;
            } else {
              const selfFields = selfRelationFieldNames(schema, persistTarget.entity);
              const crossRels = crossEntityRestrictRelations(schema, persistTarget.entity);
              const crossEntity = crossRels.length > 0
                ? await Promise.all(crossRels.map(async (rel) => ({ field: rel.fieldName, rows: await persistence.list(rel.entityName) })))
                : undefined;
              const picked = pickTargetRow(entityRows, entityRows, selfFields.length > 0 ? selfFields : undefined, { crossEntity });
              if ('row' in picked && typeof picked.row['id'] === 'string') deleteTargetId = picked.row['id'];
            }
          }

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
          // Whichever piece supplied `id` (the payload synthesizer, or the
          // dispatched transition's OWN guard — e.g. `?id != ""` — via
          // `buildGuardPayloads`) targets nothing real. Swap in the row seeded
          // above so a by-id fetch this dispatch triggers actually hits,
          // AFTER the merge so it wins regardless of which piece produced it.
          if (persistence !== undefined && sourceTrait.linkedEntity !== undefined && 'id' in payload) {
            payload['id'] = deleteTargetId ?? effectiveSeedId(schema, runtime, sourceTrait.linkedEntity);
          }
          // A `persist create|update <Entity> @payload.<field>` effect writes
          // the ENTIRE dispatched `<field>` object as the row — `id`/owner
          // columns synthesized generically for it (random strings, matching
          // no real identity) fail the entity's own `@update`/`@create` access
          // policy, which is evaluated against exactly this object
          // (`orbital-lolo`'s `data : @entity!` payload contract, seen live:
          // `NotePersistor.DO_UPDATE`'s `(persist update Note @payload.data
          // {...})` rejected with "@update denied" until this patch). Correct
          // ONLY the identity fields to match the row seeded above — the rest
          // of the synthesized row (title, content, …) stays as-is so a
          // required-field validator still sees them populated; a full
          // object swap would lose those. The whole-row field itself comes
          // from the `PayloadField.entity` marker (stamped on both paths for
          // the `@entity` sigil since Stage C) via `findPersistWholeRowField`.
          if (persistence !== undefined && sourceTrait.linkedEntity !== undefined) {
            const linkedEntity = sourceTrait.linkedEntity;
            const wholeRowField = findPersistWholeRowField(transition.effects ?? [], eventDecl?.payloadSchema);
            if (wholeRowField !== null) {
              const current = payload[wholeRowField];
              const row: EventPayload = isPlainEventPayload(current) ? { ...current } : {};
              row['id'] = deleteTargetId ?? effectiveSeedId(schema, runtime, linkedEntity);
              if (viewerId !== undefined) {
                for (const field of ownerFieldNames(schema, linkedEntity)) {
                  if (field === 'id') continue;
                  row[field] = viewerId;
                }
              }
              payload[wholeRowField] = row;
            }
          }

          const deliveredHops: Array<{ traitName: string; event: string }> = [];
          const unobserve = runtime.observeTransitions({ onTransition: (t) => { deliveredHops.push({ traitName: t.traitName, event: t.event }); } });
          const response = await runtime.processOrbitalEvent(sourceOrbitalName, {
            event: transition.event,
            payload,
            targetTrait: source.trait,
          });

          const sourceEmitted = response.success && response.emittedEvents.some((e) => e.event === listen.event);
          if (!sourceEmitted) {
            unobserve();
            // C1-V19 (item 5): the chosen arm didn't fire — report the REAL
            // cause instead of blindly blaming the guard. `response.
            // effectResults` (unread until this fix) carries the actual
            // outcome of any `persist`/`set`/`call-service` effect the arm
            // ran: `denied: true` means an access policy rejected the
            // synthesized payload/viewer, a `success: false` entry with its
            // own `error` means the effect itself failed (e.g. no row key) —
            // neither is a guard problem at all. `response.error` (API-
            // boundary payload validation) is checked next. Only when NONE
            // of those fired AND the dispatched transition actually
            // DECLARES a guard is "guard rejected" an honest explanation;
            // otherwise say so plainly rather than naming a mechanism that
            // isn't even present.
            const deniedEffect = response.effectResults?.find((e) => e.denied === true);
            const failedEffect = response.effectResults?.find((e) => e.success === false && e.denied !== true);
            const cause = deniedEffect !== undefined
              ? `denied by access policy (${deniedEffect.entityType ?? persistTarget?.entity ?? 'entity'}${deniedEffect.action !== undefined ? ` ${deniedEffect.action}` : ''})`
              : failedEffect !== undefined
                ? `failed: ${failedEffect.error ?? 'effect did not succeed'}`
                : response.error !== undefined
                  ? response.error
                  : transition.guard !== undefined && transition.guard !== null
                    ? 'guard rejected the synthesized payload'
                    : 'the transition did not fire for an unknown reason (no guard declared, no reported effect failure)';
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
                `did not emit ${listen.event} (${cause})`,
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

          unobserve();
          const normalizedTriggers = normalizeEventKey(listen.triggers);
          // Per-hop evidence: the listener's final `lastEvent` is last-writer-wins across a multi-event dispatch.
          const delivered = deliveredHops.some(
            (h) => h.traitName === listenerName && normalizeEventKey(h.event) === normalizedTriggers,
          );

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
        } finally {
          // Scoped to exactly this probed dispatch — a DIFFERENT persist
          // transition later in this same run may need a DIFFERENT (even
          // mutually exclusive) role, so the switch must not leak past the
          // check it was synthesized for.
          if (roleSwitched) runtime.setDefaultUser(originalUser);
        }
      }
    }
  }

  return { probed, findings, errors: findings.length };
}
