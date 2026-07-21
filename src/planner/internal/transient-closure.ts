/**
 * `transientClosure` — states reachable from `start` by following
 * transitions whose event is *effect-emitted* (auto-fired by an effect's
 * `emit`, not a user). A state with such an outgoing transition advances to
 * its target the instant the effect resolves, so anything that lands ON
 * `start` — a direct transition INTO it, or a reconcile/replay hop walking
 * back to it as a precondition — can legitimately settle anywhere in the
 * closure by the time the kernel observes. Returns `[start]` when the trait
 * declares no effect-emitted events (the common case).
 *
 * Single source of truth: `planWalk` (direct-step `acceptStates`) and
 * `planReplayTo` (reconcile-hop `acceptStates`) both call this so a
 * transition INTO a transient state and a reconcile hop landing on the
 * same state are tolerated identically.
 *
 * @packageDocumentation
 */

import type { TraitWalkConfig } from '../../engine/types.js';

export function transientClosure(start: string, trait: TraitWalkConfig): string[] {
  const emitted = trait.effectEmittedEvents;
  if (emitted === undefined || emitted.size === 0) return [start];
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const state = queue.shift() as string;
    for (const t of trait.transitions) {
      if (!emitted.has(t.event)) continue;
      if (!fromMatches(t.from, state)) continue;
      if (!seen.has(t.to)) {
        seen.add(t.to);
        queue.push(t.to);
      }
    }
  }
  return [...seen];
}

function fromMatches(from: TraitWalkConfig['transitions'][number]['from'], state: string): boolean {
  if (from === '*') return true;
  if (Array.isArray(from)) return from.includes(state);
  return from === state;
}
