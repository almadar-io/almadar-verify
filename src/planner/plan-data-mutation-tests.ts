/**
 * `planDataMutationTests` — pure planner that produces ExtendedWalkSteps
 * for CRUD verification (Phase 4b+ lift).
 *
 * Reads the parsed `OrbitalSchema` directly: walks each trait's
 * `stateMachine.transitions[].effects[]` looking for `persist` effects
 * (`['persist', 'create'|'update'|'delete', <Entity>, ...]`). Each
 * matching transition becomes one DOM-trigger step with
 * `testKind: 'data-mutation'` and `expectedRowDelta` derived from the
 * persist kind (+1 / -1 / 0).
 *
 * Pure. No `Page`, no DOM.
 *
 * @packageDocumentation
 */

import type { FieldValue, OrbitalSchema, Trait } from '@almadar/core';
import { constTruth } from '@almadar/core';
import type { ExtendedWalkStep } from './types.js';
import type { TraitWalkConfig } from '../engine/types.js';
import { eachInlineTrait, findInitialState } from './internal/orbital-walk.js';
import { collectEffectEmittedEvents } from './internal/effect-emits.js';
import {
  collectEntityIdBindingTransitions,
  containsEntityIdSet,
  findPersistKind,
  findPersistPayloadBinding,
  findRowCreatingSelfLoop,
  findRowSelectingTransitionFromState,
} from './internal/persist-binding.js';
import { planGuardPreconditionPreamble } from './internal/guard-precondition.js';
import { collectEntityFields } from './internal/payload-synth.js';
import { buildMinimalPayload, type EntityFieldDef } from '../browser/interaction.js';
import { deriveViewerRequirement, type ViewerRequirement } from './internal/viewer-requirement.js';
import { selfRelationFieldNames } from './internal/self-relation-fields.js';
import { extractTraitWalkConfigs } from './extract-trait-walk-configs.js';
import { planReplayTo } from './plan-replay-to.js';

export function planDataMutationTests(orbital: OrbitalSchema): ExtendedWalkStep[] {
  const result: ExtendedWalkStep[] = [];
  const entityFieldsByName = collectEntityFields(orbital);
  // C1-V14 (F4): `planRowEstablishPreamble` needs the same `TraitWalkConfig`
  // shape `runVerification`'s reconcile preamble walks with, to compute the
  // IDENTICAL `planReplayTo` path and check whether it traverses the
  // row-establishing transition. Built once per orbital (same granularity
  // `runVerification` already builds it at).
  const traitWalkConfigsByName = new Map<string, TraitWalkConfig>(
    extractTraitWalkConfigs(orbital).map((config) => [config.traitName, config]),
  );

  for (const { trait } of eachInlineTrait(orbital)) {
    if (trait.stateMachine === undefined) continue;
    const initial = findInitialState(trait.stateMachine);
    if (initial === null) continue;
    // Events an EFFECT fires (a fetch/persist `emit.success`/`emit.failure`
    // callback), not a user affordance — e.g. std-data-erasure's tick-fired
    // `ExecScanLoaded`. In production its entity-array payload comes from a
    // REAL fetch against the live store, so `@entity.id` extracted from it
    // resolves to a real row. A directly-synthesized test payload can't
    // correlate with the mock store's actual seeded rows the same way, so
    // dispatching it straight and expecting the subsequent `persist` to
    // find a matching row is an artifact of the test harness, not a real
    // product bug — the same "can't drive deterministically" reasoning
    // `planReplayTo`'s BFS already applies when excluding these as hops.
    const effectEmittedEvents = collectEffectEmittedEvents(trait.stateMachine.transitions);

    for (const transition of trait.stateMachine.transitions) {
      if (transition.event === 'INIT') continue;
      if (effectEmittedEvents.has(transition.event)) continue;
      // A guard the config resolution already collapsed to a constant
      // `false` (e.g. an `enabled: false` call site substituted at
      // inline time) can never fire at runtime — planning a mutation
      // step for it guarantees a cascade=[] failure.
      if (transition.guard !== undefined && constTruth(transition.guard) === false) continue;
      const persist = findPersistKind(transition.effects ?? []);
      if (persist === null) continue;
      // PersistEffect's shape is always `['persist', kind, entity, payload]`
      // per `@almadar/core`'s `PersistEffect` type. Schemas missing the
      // entity arg fail validation upstream; the planner doesn't need
      // a fallback.
      const entityName = persist.entity;

      // Synthesize a payload from the dispatching event's payloadSchema
      // + the persist target entity's fields. Without this, every
      // data-mutation step dispatched with `payload: {}` and the
      // persist effect's `@payload.data` resolved to `undefined`,
      // which made `create` insert nothing and the gate fail.
      // Prefer the persist target's entity fields over the trait's
      // linked entity — `["persist", "create", "CartItem", ...]` writes
      // to CartItem regardless of the trait's `linkedEntity`.
      const stepPayload = synthesizeEventPayload(trait, transition.event, entityName, entityFieldsByName);

      // C1-V9 item B: the persist step's OWN data/id argument may carry
      // the target row (or its id) directly in THIS step's payload — the
      // persistor shape (`(persist update Note ?data)` / `(persist delete
      // Note ?id)`) V8's two preamble finders don't cover, because neither
      // looks at the persist call's own arguments. Checked BEFORE the
      // preamble logic below: a self-binding persist needs no preamble at
      // all, and must not be reported `unreachableRowReason` just because
      // no `@entity.id`-binding transition exists elsewhere.
      const selfBinding = persist.kind === 'create'
        ? null
        : findPersistPayloadBinding(transition.effects ?? [], extractPayloadSchema(trait, transition.event), entityName);

      // R-PERSIST-NO-ROW-KEY-SILENT-SUCCESS (C1-V8): `update`/`delete`
      // steps need the target row to exist before they fire. Only
      // relevant when `runVerification`'s own reconcile preamble never
      // runs for this step at all, AND the step doesn't self-bind its own
      // row (above) — see `planRowEstablishPreamble`'s doc.
      let establishPlan = persist.kind === 'create' || selfBinding !== null
        ? {}
        : planRowEstablishPreamble(
            orbital,
            trait,
            transition.from,
            initial,
            entityName,
            entityFieldsByName,
            traitWalkConfigsByName.get(trait.name),
          );

      // C1-V15 item A: a guard reading a NON-id `@entity.<field>` this
      // trait never establishes itself — a SEPARATE precondition from the
      // `@entity.id` row-identity shape above (and the ONLY precondition a
      // `create` step can have, since `create` never runs the row-identity
      // preamble at all). Only checked when the row-identity machinery
      // above found nothing to do — a step that already has its OWN
      // establishing preamble keeps it; `establishesRow` carries exactly
      // one preamble per step, and no corpus case needs both today.
      if (
        establishPlan.establishesRow === undefined &&
        establishPlan.unreachableRowReason === undefined &&
        transition.guard !== undefined
      ) {
        const guardPlan = planGuardPreconditionPreamble(orbital, trait, transition, transition.from, entityFieldsByName);
        if (guardPlan.establishesRow !== undefined) {
          establishPlan = { establishesRow: guardPlan.establishesRow };
        } else if (guardPlan.guardPreconditionUnreachable !== undefined) {
          establishPlan = { unreachableRowReason: guardPlan.guardPreconditionUnreachable };
        }
      }

      // C1-V9 item A: the viewer THIS step's own persist action needs to
      // run as. A creator preamble's OWN requirement (attached inside
      // `establishPlan.establishesRow`) governs the whole `tick()` call
      // instead when present — see `establishesRow.viewerRequirement`'s
      // doc — so this is only attached standalone.
      const viewerRequirement: ViewerRequirement | undefined =
        establishPlan.establishesRow?.viewerRequirement !== undefined
          ? undefined
          : deriveViewerRequirement(orbital, entityName, persist.kind);

      // C1-V9 item B follow-on: a `delete` self-binding needs a row no
      // OTHER row references through a self-relation field (`parentId`,
      // the record-detail generic's rewritten `seedRow`, …) — the mock
      // seeder's self-referential tree shape makes the structurally-
      // default row a root with children every time, which an
      // `onDelete: restrict` rule then rejects regardless of viewer.
      const selfRelationFields = selfBinding !== null && persist.kind === 'delete'
        ? selfRelationFieldNames(orbital, entityName)
        : [];

      result.push({
        from: transition.from,
        event: transition.event,
        to: transition.to,
        guardCase: null,
        payload: stepPayload,
        isRepositioning: false,
        traitName: trait.name,
        triggerKind: 'dom',
        coverageKey: `${trait.name}:${transition.from}+${transition.event}->${transition.to}[data-mutation:${persist.kind}]`,
        testKind: 'data-mutation',
        expectedRowDelta: { entityName, delta: deltaFor(persist.kind) },
        ...(persist.successEvent !== undefined && { expectedSuccessEvent: persist.successEvent }),
        ...(establishPlan.establishesRow !== undefined && { establishesRow: establishPlan.establishesRow }),
        ...(establishPlan.unreachableRowReason !== undefined && { unreachableRowReason: establishPlan.unreachableRowReason }),
        ...(selfBinding !== null && {
          bindRowFrom: {
            entityName,
            payloadField: selfBinding.payloadField,
            wholeRow: selfBinding.wholeRow,
            ...(selfRelationFields.length > 0 && { avoidReferencedVia: selfRelationFields }),
          },
        }),
        ...(viewerRequirement !== undefined && { viewerRequirement }),
      });
    }
  }

  return result;
}

// ── internal ─────────────────────────────────────────────────────────

function deltaFor(kind: 'create' | 'update' | 'delete'): number {
  if (kind === 'create') return 1;
  if (kind === 'delete') return -1;
  return 0;
}

/**
 * C1-V8 — R-PERSIST-NO-ROW-KEY-SILENT-SUCCESS, the `from === initialState`
 * gap: `runVerification`'s own state-topology reconcile preamble (which
 * dispatches `planReplayTo`'s hops — including any row-establishing
 * transition that happens to sit on that path — in the SAME reset window
 * as the real step, via `entityIdBindingByTrait` / `seedEntityIdIfBinding`
 * for the payload-bound shape) only runs when `step.from !==
 * trait.initialState && step.from !== '*'`. When the update/delete step
 * fires directly from the trait's initial state (or a wildcard-source
 * arm), that guard skips reconcile entirely — reachability is trivially
 * satisfied — but the row this step's persist writes to may never have
 * been created in THIS reset's live instance.
 *
 * C1-V14 (F4) generalizes this to `fromState !== initialState` too: the
 * reconcile preamble DOES run in that case, but its `planReplayTo` path is
 * a BFS SHORTEST path from `initialState` — which never revisits its own
 * source state, so a self-loop AT the initial state (PF's `CREATE_TASK:
 * backlog -> backlog`) is never a hop on the path to a state reached FROM
 * that same initial state (PF's `MOVE_STAGE: in_progress -> in_progress`,
 * whose replay is just `START_TASK: backlog -> in_progress` — a plain
 * update, not an id-binding transition). The row is never created before
 * the dependent step fires, same defect, different `fromState`.
 *
 * Detection: compute the SAME `planReplayTo` path the pipeline will walk.
 *   - `null` (genuinely unreachable) — not this function's job; the
 *     existing precondition-unreachable handling in `runVerification`
 *     already skips the step honestly. Return `{}`.
 *   - Some hop ON that path is itself an id-binding transition
 *     (`collectEntityIdBindingTransitions`) or a `persist create` of
 *     `entityName` that binds `@entity.id` (the `findRowCreatingSelfLoop`
 *     shape, checked per-hop rather than restricted to a self-loop) — the
 *     reconcile preamble's own dispatch of that hop (via
 *     `seedEntityIdIfBinding`, or the create hop's own effects) already
 *     establishes the row exactly as before this generalization. Return
 *     `{}` — adding a SECOND preamble here would double-dispatch it.
 *   - Neither: the establishing transition is NOT reachable on the path
 *     the reconcile preamble actually walks (PF's shape) — fall through
 *     to the SAME two disjuncts below, evaluated at `initialState` (never
 *     at `fromState`, which by construction has no establishing
 *     transition of its own reachable via replay), and mark the result
 *     `beforeReplay: true` so `runVerification` dispatches it itself,
 *     before the replay hops, instead of `tick()` dispatching it inline.
 *
 * The two disjuncts (shared between the `fromState === initialState` case
 * and the `beforeReplay` fall-through, always evaluated AT the state named
 * `atState`), checked in order:
 *   1. `findRowCreatingSelfLoop` — a `persist create` transition FROM
 *      `atState` that binds `@entity.id` and lands BACK on `atState`
 *      (PF's `CREATE_TASK -> backlog` self-loop). Its payload is
 *      synthesized the exact same way this file already synthesizes every
 *      other data-mutation step's payload — `create` steps for the same
 *      entity already succeed with this synthesis (verified by the
 *      coordinator's `OrbitalServerRuntime` probe), so reusing it here
 *      needs no new logic.
 *   2. `findRowSelectingTransitionFromState` — a transition FROM `atState`
 *      that binds `@entity.id` from a literal top-level `@payload.<field>`
 *      reference (editing a pre-existing row rather than creating one).
 *      The planner can't know a REAL row id ahead of time; `bindRowFrom`
 *      tells `tick()`/`runVerification` to fill one in from a seeded row
 *      at dispatch.
 *
 * Neither found: the trait never legitimately binds this entity's row
 * identity at `atState` at all — `unreachableRowReason` documents why
 * instead of letting the step fail silently.
 */
function planRowEstablishPreamble(
  orbital: OrbitalSchema,
  trait: Trait,
  fromState: string,
  initialState: string,
  entityName: string,
  entityFieldsByName: Record<string, EntityFieldDef[]>,
  traitWalkConfig: TraitWalkConfig | undefined,
): { establishesRow?: ExtendedWalkStep['establishesRow']; unreachableRowReason?: string } {
  if (fromState === '*') return {};

  if (fromState === initialState) {
    return resolveRowEstablishAt(orbital, trait, initialState, entityName, entityFieldsByName, false);
  }

  // F4 fall-through: `fromState` differs from the initial state — check
  // whether the reconcile preamble's OWN replay path already establishes
  // the row before assuming a second preamble is needed.
  if (traitWalkConfig === undefined) return {};
  const replayPath = planReplayTo({ trait: traitWalkConfig, targetState: fromState }, entityFieldsByName);
  if (replayPath === null) return {};
  if (replayPathEstablishesRow(trait, entityName, replayPath)) return {};

  return resolveRowEstablishAt(orbital, trait, initialState, entityName, entityFieldsByName, true);
}

/** `true` iff some hop on `replayPath` already binds `entityName`'s row
 *  identity — either the trait's own declared `@entity.id`-binding
 *  transition set (`collectEntityIdBindingTransitions`), or the hop's own
 *  effects are a `persist create` of `entityName` that also binds
 *  `@entity.id` (the {@link findRowCreatingSelfLoop} shape, checked at
 *  hop granularity rather than restricted to a self-loop landing on the
 *  hop's OWN source state). Either way the reconcile preamble's existing
 *  dispatch of that hop already establishes the row — see
 *  `planRowEstablishPreamble`'s doc. */
function replayPathEstablishesRow(
  trait: Trait,
  entityName: string,
  replayPath: ReadonlyArray<ExtendedWalkStep>,
): boolean {
  const idBindings = collectEntityIdBindingTransitions(trait);
  return replayPath.some((hop) => {
    if (idBindings.has(`${hop.from}+${hop.event}->${hop.to}`)) return true;
    const raw = trait.stateMachine?.transitions.find(
      (t) => t.from === hop.from && t.event === hop.event && t.to === hop.to,
    );
    if (raw === undefined) return false;
    const persist = findPersistKind(raw.effects ?? []);
    return (
      persist !== null &&
      persist.kind === 'create' &&
      persist.entity === entityName &&
      containsEntityIdSet(raw.effects ?? [])
    );
  });
}

/** The two disjuncts shared by both the `fromState === initialState` case
 *  and the F4 `beforeReplay` fall-through — see `planRowEstablishPreamble`'s
 *  doc. `beforeReplay` is stamped onto the result only in the fall-through
 *  case (`atState` there is the trait's initial state, not the step's own
 *  `fromState`, which is what `runVerification` needs to know to dispatch
 *  this itself instead of leaving it to `tick()`'s in-step handling). */
function resolveRowEstablishAt(
  orbital: OrbitalSchema,
  trait: Trait,
  atState: string,
  entityName: string,
  entityFieldsByName: Record<string, EntityFieldDef[]>,
  beforeReplay: boolean,
): { establishesRow?: ExtendedWalkStep['establishesRow']; unreachableRowReason?: string } {
  const creator = findRowCreatingSelfLoop(trait, atState, entityName);
  if (creator !== null) {
    // C1-V9 item A: the creator's OWN `persist create` needs a viewer
    // satisfying the entity's `@create` policy — derived here (not from
    // the dependent update/delete step's policy) because it governs the
    // whole `tick()` call: same live row, same persona throughout.
    const creatorViewerRequirement = deriveViewerRequirement(orbital, entityName, 'create');
    return {
      establishesRow: {
        event: creator.event,
        payload: synthesizeEventPayload(trait, creator.event, entityName, entityFieldsByName),
        ...(creatorViewerRequirement !== undefined && { viewerRequirement: creatorViewerRequirement }),
        ...(beforeReplay && { beforeReplay: true }),
      },
    };
  }

  const selector = findRowSelectingTransitionFromState(trait, atState);
  if (selector !== null) {
    return {
      establishesRow: {
        event: selector.event,
        payload: synthesizeEventPayload(trait, selector.event, entityName, entityFieldsByName),
        bindRowFrom: { entityName, payloadField: selector.payloadPath },
        ...(beforeReplay && { beforeReplay: true }),
      },
    };
  }

  return {
    unreachableRowReason:
      `no target row: trait '${trait.name}' declares no create+id-bind self-loop and no @payload id-binding `
      + `transition reachable from '${atState}' — the '${entityName}' row this step writes to can never exist `
      + 'before it fires',
  };
}

function synthesizeEventPayload(
  trait: Trait,
  eventKey: string,
  entityName: string,
  entityFieldsByName: Record<string, EntityFieldDef[]>,
): Record<string, FieldValue> {
  const payloadSchema = extractPayloadSchema(trait, eventKey);
  const persistEntityFields = entityFieldsByName[entityName];
  return payloadSchema.length > 0
    ? (buildMinimalPayload(payloadSchema, persistEntityFields) as Record<string, FieldValue>)
    : {};
}

function extractPayloadSchema(
  trait: Trait,
  eventKey: string,
): Array<{ name: string; type: string; required?: boolean; entity?: string }> {
  const event = trait.stateMachine?.events.find((e) => e.key === eventKey);
  if (event === undefined || event.payloadSchema === undefined) return [];
  return event.payloadSchema.map((f) => ({
    name: f.name,
    type: f.type,
    required: f.required,
    entity: f.entity,
  }));
}

