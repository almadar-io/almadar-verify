/**
 * `http-routes` — the events an `http` effect delivers its outcome on.
 *
 * Without network the request is issued and fails, so the failure route runs for real and every other route
 * (`success`, `cancelled`, `onMessage`) is unreachable. Neither is planned as a standalone step.
 *
 * @packageDocumentation
 */

import { splitEventAddress, type Effect, type ListenSource, type OrbitalSchema, type SExpr } from '@almadar/core';
import { eachInlineTrait } from './orbital-walk.js';

export interface HttpRoutes {
  /** Events on the non-failure routes of an `http` effect. */
  reply: Set<string>;
  /** Events on the `failure` route of an `http` effect. */
  failure: Set<string>;
}

const REPLY_ROUTE_KEYS: ReadonlySet<string> = new Set(['success', 'cancelled', 'onMessage', 'on_message']);

export function collectHttpRoutes(transitions: ReadonlyArray<{ effects?: ReadonlyArray<Effect> }>): HttpRoutes {
  const routes: HttpRoutes = { reply: new Set(), failure: new Set() };
  for (const transition of transitions) {
    for (const effect of transition.effects ?? []) visit(effect, routes);
  }
  return routes;
}

function visit(node: Effect | SExpr, routes: HttpRoutes): void {
  if (!Array.isArray(node)) return;
  const nodes = node as readonly SExpr[];
  if (nodes[0] === 'http') {
    for (const arg of nodes) {
      if (arg === null || typeof arg !== 'object' || Array.isArray(arg)) continue;
      const emit = (arg as Readonly<Record<string, SExpr>>)['emit'];
      if (emit === null || typeof emit !== 'object' || Array.isArray(emit)) continue;
      for (const [key, event] of Object.entries(emit as Readonly<Record<string, SExpr>>)) {
        if (typeof event !== 'string' || event === '' || event.startsWith('@')) continue;
        if (key === 'failure') routes.failure.add(event);
        else if (REPLY_ROUTE_KEYS.has(key)) routes.reply.add(event);
      }
    }
  }
  for (const child of nodes) visit(child, routes);
}

/** Whether a listen's `source` accepts `emitter` as the emitting trait (no source, any, or the source naming it). */
function acceptsEmitter(source: ListenSource | undefined, emitter: string): boolean {
  return source === undefined || source.kind === 'any' || source.trait === emitter;
}

/**
 * Each trait's http routes by real delivery: the emitting trait's own arms for the event, plus every trait whose
 * `listens` entry names the event and accepts the emitter as its source, marked on the listen's `triggers`
 * event (or the event itself). A legacy `Source.EVENT` address is split first.
 */
export function httpRoutesByTrait(orbital: OrbitalSchema): Map<string, HttpRoutes> {
  const own = new Map<string, HttpRoutes>();
  const traits = [...eachInlineTrait(orbital)].map(({ trait }) => trait);
  for (const trait of traits) own.set(trait.name, collectHttpRoutes(trait.stateMachine?.transitions ?? []));
  const delivered = new Map<string, HttpRoutes>();
  const routesOf = (name: string): HttpRoutes => {
    const existing = delivered.get(name);
    if (existing !== undefined) return existing;
    const created: HttpRoutes = { reply: new Set(), failure: new Set() };
    delivered.set(name, created);
    return created;
  };
  for (const [emitter, routes] of own) {
    const emitting = routesOf(emitter);
    for (const event of routes.reply) emitting.reply.add(event);
    for (const event of routes.failure) emitting.failure.add(event);
    for (const listener of traits) {
      for (const listen of listener.listens ?? []) {
        const split = listen.source === undefined ? splitEventAddress(listen.event) : { event: listen.event, source: listen.source };
        if (!acceptsEmitter(split.source, emitter)) continue;
        const marked = listen.triggers ?? split.event;
        if (routes.reply.has(split.event)) routesOf(listener.name).reply.add(marked);
        if (routes.failure.has(split.event)) routesOf(listener.name).failure.add(marked);
      }
    }
  }
  return delivered;
}
