/**
 * `extractTraitWalkConfigs` — pure derivation from a parsed `OrbitalSchema`
 * to the kernel's `TraitWalkConfig[]`. Used by `runVerification` to feed
 * the kernel walker with the per-trait state machines.
 *
 * Pure. Thin wrapper over `eachInlineTrait` + `findInitialState` +
 * `toEdgeWalkTransition` from `internal/orbital-walk.ts`.
 *
 * @packageDocumentation
 */

import type { OrbitalSchema } from '@almadar/core';
import type { TraitWalkConfig } from '../engine/types.js';
import { collectEffectEmittedEvents } from './internal/effect-emits.js';
import {
  eachInlineTrait,
  findDefaultRoute,
  findInitialState,
  findRouteForTrait,
  toEdgeWalkTransition,
} from './internal/orbital-walk.js';

export function extractTraitWalkConfigs(orbital: OrbitalSchema): TraitWalkConfig[] {
  const result: TraitWalkConfig[] = [];

  for (const { orb, trait } of eachInlineTrait(orbital)) {
    if (trait.stateMachine === undefined) continue;
    const initialState = findInitialState(trait.stateMachine);
    if (initialState === null) continue;

    const config: TraitWalkConfig = {
      traitName: trait.name,
      initialState,
      transitions: trait.stateMachine.transitions.map(toEdgeWalkTransition),
      events: trait.stateMachine.events,
    };
    if (trait.linkedEntity !== undefined) {
      config.linkedEntity = trait.linkedEntity;
    }
    const effectEmittedEvents = collectEffectEmittedEvents(trait.stateMachine.transitions);
    if (effectEmittedEvents.size > 0) {
      config.effectEmittedEvents = effectEmittedEvents;
    }
    if (trait.ticks !== undefined && trait.ticks.length > 0) {
      config.ticks = trait.ticks;
    }
    if (trait.emits !== undefined && trait.emits.length > 0) {
      config.emitContracts = trait.emits;
    }
    const route = findRouteForTrait(orb, trait.name) ?? findDefaultRoute(orb);
    if (route !== null) {
      (config as { route?: string }).route = route;
    }
    result.push(config);
  }

  return result;
}
