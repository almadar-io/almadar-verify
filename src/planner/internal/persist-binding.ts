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

import type { Effect, OrbitalSchema, SExpr, Trait } from '@almadar/core';
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

function containsEntityIdSet(effects: ReadonlyArray<Effect>): boolean {
  for (const effect of effects) {
    if (findEntityIdSet(effect) !== undefined) return true;
  }
  return false;
}

function findEntityIdSetPayloadPath(effects: ReadonlyArray<Effect>): string | null {
  for (const effect of effects) {
    const value = findEntityIdSet(effect);
    if (typeof value === 'string' && value.startsWith(PAYLOAD_PREFIX)) {
      return value.slice(PAYLOAD_PREFIX.length);
    }
  }
  return null;
}
