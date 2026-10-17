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
import { httpRoutesByTrait } from './internal/http-routes.js';
import {
  dispatchNavigates,
  eachInlineTrait,
  findDefaultRoute,
  findInitialState,
  findRouteForTrait,
  findRouteForEmbedClosure,
  findRouteParamEntities,
  toEdgeWalkTransition,
} from './internal/orbital-walk.js';

export function extractTraitWalkConfigs(orbital: OrbitalSchema): TraitWalkConfig[] {
  const result: TraitWalkConfig[] = [];
  const httpRoutes = httpRoutesByTrait(orbital);

  for (const { orb, trait } of eachInlineTrait(orbital)) {
    if (trait.stateMachine === undefined) continue;
    const initialState = findInitialState(trait.stateMachine);
    if (initialState === null) continue;

    const config: TraitWalkConfig = {
      traitName: trait.name,
      initialState,
      transitions: trait.stateMachine.transitions.map((t) => {
        const edge = toEdgeWalkTransition(t);
        // `toEdgeWalkTransition` only sees the dispatched transition's OWN
        // effects; `dispatchNavigates` also credits a listener whose
        // triggered arm navigates (the dispatched trait itself never does,
        // but the route still changes) — a strict superset, so this only
        // ever flips `navigates` false→true, never the reverse.
        if (!edge.navigates && dispatchNavigates(orbital, orb, trait.name, t.event)) {
          edge.navigates = true;
        }
        return edge;
      }),
      events: trait.stateMachine.events,
    };
    if (trait.linkedEntity !== undefined) {
      config.linkedEntity = trait.linkedEntity;
    }
    const effectEmittedEvents = collectEffectEmittedEvents(trait.stateMachine.transitions);
    if (effectEmittedEvents.size > 0) {
      config.effectEmittedEvents = effectEmittedEvents;
    }
    const traitRoutes = httpRoutes.get(trait.name);
    if (traitRoutes !== undefined && traitRoutes.reply.size > 0) config.httpReplyEvents = traitRoutes.reply;
    if (traitRoutes !== undefined && traitRoutes.failure.size > 0) config.httpFailureEvents = traitRoutes.failure;
    if (trait.ticks !== undefined && trait.ticks.length > 0) {
      config.ticks = trait.ticks;
    }
    if (trait.emits !== undefined && trait.emits.length > 0) {
      config.emitContracts = trait.emits;
    }
    const route = findRouteForTrait(orb, trait.name) ?? findRouteForEmbedClosure(orb, trait.name) ?? findDefaultRoute(orb);
    if (route !== null) {
      (config as { route?: string }).route = route;
      const routeParamEntities = findRouteParamEntities(orb, route);
      if (Object.keys(routeParamEntities).length > 0) config.routeParamEntities = routeParamEntities;
    }
    result.push(config);
  }

  return result;
}
