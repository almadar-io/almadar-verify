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

import type { OrbitalSchema, Trait } from '@almadar/core';
import type { ExtendedWalkStep } from './types.js';
import { eachInlineTrait, findInitialState } from './internal/orbital-walk.js';

export function planDataMutationTests(orbital: OrbitalSchema): ExtendedWalkStep[] {
  const result: ExtendedWalkStep[] = [];

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

      result.push({
        from: transition.from,
        event: transition.event,
        to: transition.to,
        guardCase: null,
        payload: {},
        isRepositioning: false,
        traitName: trait.name,
        triggerKind: 'dom',
        coverageKey: `${trait.name}:${transition.from}+${transition.event}->${transition.to}[data-mutation:${persist.kind}]`,
        testKind: 'data-mutation',
        expectedRowDelta: { entityName, delta: deltaFor(persist.kind) },
      });
    }
  }

  return result;
}

// ── internal ─────────────────────────────────────────────────────────

interface PersistEffectInfo {
  kind: 'create' | 'update' | 'delete';
  entity: string;
}

function findPersistKind(effects: ReadonlyArray<unknown>): PersistEffectInfo | null {
  for (const effect of effects) {
    if (!Array.isArray(effect)) continue;
    if (effect[0] !== 'persist') continue;
    const kind = effect[1];
    if (kind !== 'create' && kind !== 'update' && kind !== 'delete') continue;
    if (typeof effect[2] !== 'string') continue;     // malformed schema — skip
    return { kind, entity: effect[2] };
  }
  return null;
}

function deltaFor(kind: 'create' | 'update' | 'delete'): number {
  if (kind === 'create') return 1;
  if (kind === 'delete') return -1;
  return 0;
}
