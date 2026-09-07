/**
 * `persist-binding` — two related facts about a trait's `.orb` state
 * machine, both needed to seed a REAL row id before a hermetic persist
 * step fires (docs/Almadar_Runtime_Gaps.md,
 * R-PERSIST-NO-ROW-KEY-SILENT-SUCCESS):
 *
 *   1. `findPersistKind` / `collectPersistWriteTransitions` — which
 *      transitions write a whole row (`persist create|update|delete`)
 *      and to which entity. `findPersistKind` is the SAME detector
 *      `planDataMutationTests` already used inline; relocated here so
 *      the pipeline can reuse it instead of re-parsing the effect shape.
 *   2. `traitHasEntityIdBinding` / `collectEntityIdBindingTransitions` —
 *      which transitions set `@entity.id` from a literal
 *      `@payload.<path>` binding, i.e. can legitimately establish the
 *      trait's bound row identity. Mirrors the Rust static validator's
 *      `validate_entity_fields_have_setters`
 *      (orbital-compiler/phases/validation/binding.rs): a trait failing
 *      `traitHasEntityIdBinding` is exactly the condition that already
 *      produces `ORB_BINDING_PERSIST_ROW_ID_NEVER_SET` — the one real
 *      corpus defect — so the pipeline must never seed for it; doing so
 *      would mask the defect instead of leaving it failing.
 *
 * Pure. No `Page`, no DOM, no driver.
 *
 * @packageDocumentation
 */

import type { Effect, OrbitalSchema, PayloadField, SExpr, Trait, Transition } from '@almadar/core';
import { eachInlineTrait } from './orbital-walk.js';

export interface PersistEffectInfo {
  kind: 'create' | 'update' | 'delete';
  entity: string;
  successEvent?: string;
}

/** Scan a transition's effects for a `persist create|update|delete` call. */
export function findPersistKind(effects: ReadonlyArray<Effect>): PersistEffectInfo | null {
  for (const effect of effects) {
    if (!Array.isArray(effect)) continue;
    if (effect[0] !== 'persist') continue;
    const kind = effect[1];
    if (kind !== 'create' && kind !== 'update' && kind !== 'delete') continue;
    if (typeof effect[2] !== 'string') continue;    // malformed schema — skip

    // Walk args [3..] for the trailing options object's `emit.success`.
    let successEvent: string | undefined;
    for (let i = 3; i < effect.length; i++) {
      const arg = effect[i];
      if (arg === null || typeof arg !== 'object' || Array.isArray(arg)) continue;
      const emit = (arg as Readonly<Record<string, SExpr>>)['emit'];
      if (emit === null || typeof emit !== 'object' || Array.isArray(emit)) continue;
      const success = (emit as Readonly<Record<string, SExpr>>)['success'];
      if (typeof success === 'string' && success.length > 0) {
        successEvent = success;
        break;
      }
    }

    return { kind, entity: effect[2], ...(successEvent !== undefined && { successEvent }) };
  }
  return null;
}

/**
 * Every `(from,event,to)` across the orbital whose effects write a whole
 * row, keyed `${traitName}:${from}+${event}->${to}` — the same shape
 * `runVerification` builds its step keys in, so a step's persist intent
 * is a single map lookup away.
 */
export function collectPersistWriteTransitions(orbital: OrbitalSchema): Map<string, PersistEffectInfo> {
  const out = new Map<string, PersistEffectInfo>();
  for (const { trait } of eachInlineTrait(orbital)) {
    if (trait.stateMachine === undefined) continue;
    for (const transition of trait.stateMachine.transitions) {
      const persist = findPersistKind(transition.effects ?? []);
      if (persist === null) continue;
      out.set(`${trait.name}:${transition.from}+${transition.event}->${transition.to}`, persist);
    }
  }
  return out;
}

/** Where in the dispatched payload a `(set @entity.id @payload.<path>)` reads its value from. */
export interface EntityIdBindingSource {
  payloadPath: string;
}

/**
 * `true` iff SOME transition (or tick) anywhere in the trait sets
 * `@entity.id` — the 3-argument `SetEffect` form (`['set', '@entity.id',
 * value]`), regardless of what `value` resolves to. This is the anti-mask
 * guard: only a trait that passes it has any legitimate way to bind its
 * own row identity, so only such a trait is a candidate for seeding.
 */
export function traitHasEntityIdBinding(trait: Trait): boolean {
  if (trait.stateMachine === undefined) return false;
  for (const transition of trait.stateMachine.transitions) {
    if (containsEntityIdSet(transition.effects ?? [])) return true;
  }
  for (const tick of trait.ticks ?? []) {
    if (containsEntityIdSet(tick.effects)) return true;
  }
  return false;
}

/**
 * Every `(from,event,to)` transition in ONE trait whose `set @entity.id`
 * reads a literal `@payload.<path>` binding — the only shape the pipeline
 * can correct deterministically (an id computed by a nested expression
 * has no single payload slot to inject a real value into, so those are
 * left alone rather than guessed at). Keyed `${from}+${event}->${to}`.
 */
export function collectEntityIdBindingTransitions(trait: Trait): Map<string, EntityIdBindingSource> {
  const out = new Map<string, EntityIdBindingSource>();
  if (trait.stateMachine === undefined) return out;
  for (const transition of trait.stateMachine.transitions) {
    const path = findEntityIdSetPayloadPath(transition.effects ?? []);
    if (path !== null) {
      out.set(`${transition.from}+${transition.event}->${transition.to}`, { payloadPath: path });
    }
  }
  return out;
}

/**
 * C1-V8: a transition FROM `fromState` (or the wildcard `'*'` source) that
 * `persist create`s `entityName` AND binds `@entity.id` somewhere in its
 * own effects, landing BACK on `fromState` — the "self-loop in that from
 * state" shape `planDataMutationTests` needs to establish a real row
 * before an update/delete step that also fires FROM `fromState` (PF's
 * `CREATE_TASK -> backlog` / `START_TASK: backlog -> in_progress`: the
 * creator is a literal self-loop at `backlog`). Requires the LANDING
 * state to equal `fromState` exactly — a creator landing anywhere else
 * doesn't put the runtime back where the dependent step expects to fire
 * from, so it isn't a candidate. `INIT` is excluded: it fires
 * automatically on mount, not via a re-dispatchable `sendEvent`, so
 * re-firing it mid-walk isn't a legitimate preamble.
 */
export function findRowCreatingSelfLoop(
  trait: Trait,
  fromState: string,
  entityName: string,
): Transition | null {
  if (trait.stateMachine === undefined) return null;
  for (const transition of trait.stateMachine.transitions) {
    if (transition.event === 'INIT') continue;
    if (transition.from !== fromState && transition.from !== '*') continue;
    if (transition.to !== fromState) continue;
    const persist = findPersistKind(transition.effects ?? []);
    if (persist === null || persist.kind !== 'create' || persist.entity !== entityName) continue;
    if (!containsEntityIdSet(transition.effects ?? [])) continue;
    return transition;
  }
  return null;
}

/** A transition `findRowSelectingTransitionFromState` found: the event to
 *  dispatch and the top-level payload field its `@entity.id` binding reads
 *  from (`persist-binding.ts`'s own `EntityIdBindingSource`, scoped to one
 *  candidate transition). */
export interface RowSelectingTransition {
  event: string;
  payloadPath: string;
}

/**
 * C1-V8: a transition FROM `fromState` (or `'*'`) that binds `@entity.id`
 * from a literal top-level `@payload.<field>` reference — the fetch/select-
 * bound trait shape (case 2 of `planDataMutationTests`'s preamble): editing
 * a pre-existing row rather than creating one. Only a TOP-LEVEL field
 * (`payloadPath` with no `.`) is returned — a nested path (`@payload.row.id`)
 * has no single payload slot `tick()` can inject a real row's id into at
 * dispatch time, so that shape is left for the `unreachableRowReason`
 * fallback rather than guessed at. `INIT` is excluded for the same reason
 * as {@link findRowCreatingSelfLoop}.
 */
export function findRowSelectingTransitionFromState(
  trait: Trait,
  fromState: string,
): RowSelectingTransition | null {
  if (trait.stateMachine === undefined) return null;
  for (const transition of trait.stateMachine.transitions) {
    if (transition.event === 'INIT') continue;
    if (transition.from !== fromState && transition.from !== '*') continue;
    const payloadPath = findEntityIdSetPayloadPath(transition.effects ?? []);
    if (payloadPath === null || payloadPath.includes('.')) continue;
    return { event: transition.event, payloadPath };
  }
  return null;
}

/**
 * `true` iff `field`'s lowering/resolve-stamped `entity` marker
 * (`PayloadField.entity` / `EventPayloadField.entity`) names `entityName` —
 * the ONE owner every caller in this package answers "is this payload
 * field the whole entity row" from (C1-J3, item B; converges this file's
 * {@link findPersistWholeRowField} with `plan-user-crud-flow.ts`'s delete
 * payload-row-shape, which used to inline the same one-line check). The
 * marker is stamped by `orbital-compiler`'s `resolve_sentinel_fields` /
 * `resolve_payload_type` (compiled path) and `@almadar/runtime`'s twin
 * `resolveSentinelFields` (`sentinel-resolution.ts`, runtime path) whenever
 * a payload field flattens a concrete entity type OR the `@entity`
 * self-reference sigil — both arms now stamp `entity` (verified against
 * `std-notes.orb`'s `NoteDelete.DELETE` row field on both paths, C1-J3),
 * closing the gap this detector used to work around by reading the persist
 * effect's own data-ref argument instead.
 */
export function isWholeRowField(field: Pick<PayloadField, 'entity'>, entityName: string): boolean {
  return field.entity === entityName;
}

/**
 * The top-level dispatched-payload field a `persist create|update` effect
 * reads its WHOLE ROW from — the field NAMED by the persist call's own
 * declared data argument (`['persist', 'create'|'update', Entity, ref, …]`).
 * `ref` names a whole row only when it is a bare `@payload.<field>` pointer
 * (the field IS the persisted argument, matching `orbital-lolo`'s
 * `payload_contract.rs` `check_effect` reading of the same tuple position)
 * — a literal `{ id: …, tagIds: … }` partial-update object or a scalar
 * `@payload.id` reference is a different shape and returns `null`.
 *
 * Confirms the named field via {@link isWholeRowField} against that SAME
 * `Entity` argument WHEN the field carries the marker (an explicit
 * mismatch — a marker naming a different entity than the persist declares
 * — vetoes even an `object`-typed field). A caller passing an
 * UN-resolved schema (a hand-authored fixture, or any trait that never ran
 * through `orbital-compiler`'s inline/resolve phase or `@almadar/runtime`'s
 * twin `resolveSentinelFields`) never gets the marker at all — for that
 * case only, this falls back to the field's declared `type` being
 * `object`/`[object]`, preserving this function's original,
 * marker-independent contract rather than silently going blind on
 * un-resolved input (verified against `probe-listen-cascades.test.ts`'s
 * `wholeRowPersistUpdateApp` fixture, C1-J3 item B).
 */
export function findPersistWholeRowField(
  effects: ReadonlyArray<Effect>,
  payloadSchema: ReadonlyArray<PayloadField> | undefined,
): string | null {
  for (const effect of effects) {
    if (!Array.isArray(effect)) continue;
    if (effect[0] !== 'persist') continue;
    const action = effect[1];
    if (action !== 'create' && action !== 'update') continue;
    const entityName = effect[2];
    if (typeof entityName !== 'string') continue;
    const ref = effect[3];
    if (typeof ref !== 'string') continue;
    const fieldName = /^@payload\.([A-Za-z0-9_]+)$/.exec(ref)?.[1];
    if (fieldName === undefined) continue;
    const declared = (payloadSchema ?? []).find((f) => f.name === fieldName);
    if (declared === undefined) continue;
    const isWholeRow = declared.entity !== undefined
      ? isWholeRowField(declared, entityName)
      : declared.type === 'object' || declared.type === '[object]';
    if (!isWholeRow) continue;
    return fieldName;
  }
  return null;
}

/** What {@link findPersistPayloadBinding} found: the top-level dispatched-
 *  payload field the persist step's OWN data/id argument reads the target
 *  row (or its id) from, and whether that field IS the whole row. */
export interface PersistPayloadBinding {
  payloadField: string;
  wholeRow: boolean;
}

/**
 * C1-V9 item B (R-PERSIST-NO-ROW-KEY-SILENT-SUCCESS, the persistor shape):
 * for an `update`/`delete` transition, the top-level payload field the
 * persist effect's OWN data/id argument carries the target row (or its id)
 * IN, rather than establishing it via a preceding `@entity.id`-binding
 * transition — the shape `findRowCreatingSelfLoop` /
 * `findRowSelectingTransitionFromState` (V8's two finders) don't cover,
 * because neither looks at the persist step's OWN arguments. `tick()` fills
 * this field from a seeded row at dispatch time; no preamble hop needed —
 * the step dispatches once, self-contained. Three shapes, matching
 * `orbital-lolo`'s lowering of `.lolo`'s persist call:
 *
 *   1. A bare `@payload.<field>` WHOLE-ROW pointer — {@link
 *      findPersistWholeRowField}, reused as-is (`(persist update Note
 *      ?data)` where `data : @entity!`).
 *   2. A bare `@payload.<field>` SCALAR id pointer on `delete`
 *      (`(persist delete Note ?id)`).
 *   3. A literal object argument whose OWN `id` key is a top-level
 *      `@payload.<field>` reference — a partial update keyed by id
 *      (`(persist update Note { id: ?id, content: ?content })`). A NESTED
 *      path (`{ id: ?data.id, … }`) has no single payload slot to inject a
 *      real id into and is deliberately left unmatched — same rule {@link
 *      findRowSelectingTransitionFromState} already applies to nested
 *      `@entity.id` bindings.
 *
 * `create` is excluded — there is no target row to bind, only a whole row
 * to synthesize (already handled by `plan-data-mutation-tests.ts`'s own
 * payload synthesis).
 */
export function findPersistPayloadBinding(
  effects: ReadonlyArray<Effect>,
  payloadSchema: ReadonlyArray<PayloadField> | undefined,
  entityName: string,
): PersistPayloadBinding | null {
  // `create` has no target row to bind — only `update` reuses
  // `findPersistWholeRowField`'s whole-row detector (it also matches
  // `create`, a shape this function deliberately excludes).
  const updateEffectsOnly = effects.filter((effect) => !(Array.isArray(effect) && effect[0] === 'persist' && effect[1] === 'create'));
  const wholeRowField = findPersistWholeRowField(updateEffectsOnly, payloadSchema);
  if (wholeRowField !== null) return { payloadField: wholeRowField, wholeRow: true };

  for (const effect of effects) {
    if (!Array.isArray(effect)) continue;
    if (effect[0] !== 'persist') continue;
    const action = effect[1];
    if (action !== 'update' && action !== 'delete') continue;
    if (effect[2] !== entityName) continue;
    const ref = effect[3];
    if (typeof ref === 'string') {
      const fieldName = /^@payload\.([A-Za-z0-9_]+)$/.exec(ref)?.[1];
      if (fieldName !== undefined) return { payloadField: fieldName, wholeRow: false };
      continue;
    }
    if (ref !== null && typeof ref === 'object' && !Array.isArray(ref)) {
      const idValue = (ref as Readonly<Record<string, SExpr>>)['id'];
      if (typeof idValue === 'string') {
        const fieldName = /^@payload\.([A-Za-z0-9_]+)$/.exec(idValue)?.[1];
        if (fieldName !== undefined) return { payloadField: fieldName, wholeRow: false };
      }
    }
  }
  // The fourth real shape (std-version-history `ROLLBACK {id}`, std-time-
  // tracking `SET_STATUS {id}`): the transition binds the row key itself —
  // `(set @entity.id ?id)` — and then writes `(persist update E @entity)`.
  // The id still comes from THIS step's payload, so the step self-binds
  // exactly like the `{id: ?id}` literal form; without this arm the walk
  // dispatched a synthesized id (`"E Id 1"`) that names no seeded row and
  // the store's `not found` surfaced as a failed persist on every such step.
  const setPath = findEntityIdSetPayloadPath(effects);
  if (setPath !== null) {
    const writesEntityRow = effects.some(
      (effect) =>
        Array.isArray(effect) &&
        effect[0] === 'persist' &&
        (effect[1] === 'update' || effect[1] === 'delete') &&
        effect[2] === entityName &&
        (effect[3] === '@entity' || effect[3] === '@entity.id'),
    );
    if (writesEntityRow) return { payloadField: setPath, wholeRow: false };
  }
  return null;
}

const PAYLOAD_PREFIX = '@payload.';

/**
 * Recursively walk an effect/S-expr tree for `(set "@entity.id" value)`,
 * returning `value`. `Effect`'s union carries strictly-typed nested
 * config shapes (e.g. `call-service`'s `ServiceParams`) that aren't
 * structurally `SExpr` — this scan only cares about generic `set` calls
 * wherever they appear, so it re-reads the top-level arg list as `SExpr`
 * once at the entry point and recurses purely in `SExpr` terms from
 * there, the same narrowing this file's sibling planners already do for
 * effect option objects.
 */
function findEntityIdSet(effect: Effect): SExpr | undefined {
  if (!Array.isArray(effect)) return undefined;
  return findEntityIdSetInExpr(effect as SExpr);
}

function findEntityIdSetInExpr(node: SExpr): SExpr | undefined {
  if (Array.isArray(node)) {
    if (node.length === 3 && node[0] === 'set' && node[1] === '@entity.id') {
      return node[2];
    }
    for (const child of node) {
      const found = findEntityIdSetInExpr(child);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node)) {
      const found = findEntityIdSetInExpr(value);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * `true` iff ANY effect in the list sets `@entity.id` (regardless of what
 * it's bound from). Exported so `findRowCreatingSelfLoop` (C1-V8) can
 * confirm a single candidate `create` transition legitimately binds row
 * identity, mirroring {@link traitHasEntityIdBinding}'s whole-trait scan
 * at single-transition granularity.
 */
export function containsEntityIdSet(effects: ReadonlyArray<Effect>): boolean {
  for (const effect of effects) {
    if (findEntityIdSet(effect) !== undefined) return true;
  }
  return false;
}

/**
 * The top-level `@payload.<field>` path a `set @entity.id` reads from, or
 * `null` when no effect sets `@entity.id` from a literal payload
 * reference. Exported so `findRowSelectingTransitionFromState` (C1-V8) can
 * reuse the single-transition reader `collectEntityIdBindingTransitions`
 * already builds whole-trait.
 */
export function findEntityIdSetPayloadPath(effects: ReadonlyArray<Effect>): string | null {
  for (const effect of effects) {
    const value = findEntityIdSet(effect);
    if (typeof value === 'string' && value.startsWith(PAYLOAD_PREFIX)) {
      return value.slice(PAYLOAD_PREFIX.length);
    }
  }
  return null;
}
