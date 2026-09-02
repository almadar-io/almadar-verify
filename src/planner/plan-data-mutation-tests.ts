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
import { isEntityReference, isEntityCall, constTruth } from '@almadar/core';
import type { ExtendedWalkStep } from './types.js';
import { eachInlineTrait, findInitialState } from './internal/orbital-walk.js';
import { collectEffectEmittedEvents } from './internal/effect-emits.js';
import { findPersistKind } from './internal/persist-binding.js';
import { buildMinimalPayload, type EntityFieldDef } from '../browser/interaction.js';

export function planDataMutationTests(orbital: OrbitalSchema): ExtendedWalkStep[] {
  const result: ExtendedWalkStep[] = [];
  const entityFieldsByName = collectEntityFields(orbital);

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
      const payloadSchema = extractPayloadSchema(trait, transition.event);
      const persistEntityFields = entityFieldsByName[entityName];
      const stepPayload = payloadSchema.length > 0
        ? (buildMinimalPayload(payloadSchema, persistEntityFields) as Record<string, FieldValue>)
        : {};

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

function extractPayloadSchema(
  trait: Trait,
  eventKey: string,
): Array<{ name: string; type: string; required?: boolean }> {
  const event = trait.stateMachine?.events.find((e) => e.key === eventKey);
  if (event === undefined || event.payloadSchema === undefined) return [];
  return event.payloadSchema.map((f) => ({
    name: f.name,
    type: f.type,
    required: f.required,
  }));
}

/** Mirror of plan-interaction-tests.collectEntityFields — produces an
 *  entityName → field-defs map by walking every orbital's inline + ref
 *  entities. The entity narrowing uses core's `isEntityReference` /
 *  `isEntityCall` guards. */
function collectEntityFields(orbital: OrbitalSchema): Record<string, EntityFieldDef[]> {
  const out: Record<string, EntityFieldDef[]> = {};
  for (const orb of orbital.orbitals) {
    const entityRef = orb.entity;
    if (entityRef === undefined) continue;
    if (isEntityReference(entityRef) || isEntityCall(entityRef)) continue;
    const fields = entityRef.fields ?? [];
    out[entityRef.name] = fields
      .filter((f): f is typeof f & { name: string } =>
        typeof f.name === 'string' && f.name.length > 0,
      )
      .map((f) => {
        // `values` lives on the EntityField union's Scalar (optional) and
        // Enum (required) variants only — Relation, Array, and Object don't
        // carry it. Narrow with the `in` operator so a new no-`values`
        // variant (like Object) can never slip through a negative type check.
        const values =
          ('values' in f && f.values !== undefined)
            ? [...f.values]
            : undefined;
        return {
          name: f.name,
          type: f.type,
          values,
        };
      });
  }
  return out;
}
