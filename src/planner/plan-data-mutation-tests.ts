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
import { isEntityReference, isEntityCall } from '@almadar/core';
import type { ExtendedWalkStep } from './types.js';
import { eachInlineTrait, findInitialState } from './internal/orbital-walk.js';
import { buildMinimalPayload, type EntityFieldDef } from '../browser/interaction.js';

export function planDataMutationTests(orbital: OrbitalSchema): ExtendedWalkStep[] {
  const result: ExtendedWalkStep[] = [];
  const entityFieldsByName = collectEntityFields(orbital);

  for (const { trait } of eachInlineTrait(orbital)) {
    if (trait.stateMachine === undefined) continue;
    const initial = findInitialState(trait.stateMachine);
    if (initial === null) continue;

    for (const transition of trait.stateMachine.transitions) {
      if (transition.event === 'INIT') continue;
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

interface PersistEffectInfo {
  kind: 'create' | 'update' | 'delete';
  entity: string;
  /** v3.2.0: the success-emit event key declared on the persist's
   *  `{ emit: { success: "X" } }` options block. Required by canonical-
   *  operators.json's `requiresEmitSuccess: true` on persist; the
   *  validator catches missing values upstream so the planner can
   *  trust this is populated when present in the schema. Falls back
   *  to undefined for hand-written .orb that hasn't been migrated yet —
   *  observer skips the emit-success path in that case. */
  successEvent?: string;
}

function findPersistKind(effects: ReadonlyArray<unknown>): PersistEffectInfo | null {
  for (const effect of effects) {
    if (!Array.isArray(effect)) continue;
    if (effect[0] !== 'persist') continue;
    const kind = effect[1];
    if (kind !== 'create' && kind !== 'update' && kind !== 'delete') continue;
    if (typeof effect[2] !== 'string') continue;     // malformed schema — skip

    // Walk args [3..] for the trailing options object's `emit.success`.
    let successEvent: string | undefined;
    for (let i = 3; i < effect.length; i++) {
      const arg = effect[i];
      if (arg === null || typeof arg !== 'object' || Array.isArray(arg)) continue;
      const emit = (arg as { emit?: { success?: unknown } }).emit;
      if (emit === undefined) continue;
      if (typeof emit.success === 'string' && emit.success.length > 0) {
        successEvent = emit.success;
        break;
      }
    }

    return { kind, entity: effect[2], ...(successEvent !== undefined && { successEvent }) };
  }
  return null;
}

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
      .map((f) => ({
        name: f.name,
        type: f.type,
        values: f.values !== undefined ? [...f.values] : undefined,
      }));
  }
  return out;
}
