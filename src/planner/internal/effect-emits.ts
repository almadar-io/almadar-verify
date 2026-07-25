/**
 * `effect-emits` — derive the set of events a trait's transitions fire from
 * their *effects* (not from a user affordance).
 *
 * An effect like `["fetch", "CartItem", { emit: { success: "CartItemLoaded",
 * failure: "CartItemLoadFailed" } }]` emits `CartItemLoaded` on success and
 * `CartItemLoadFailed` on failure. Those events are produced by the effect's
 * outcome callback, so:
 *   - the walk must NOT manually dispatch them as if a user triggered them
 *     (the runtime is already in the post-fetch state, so a manual dispatch
 *     is rejected — "cannot process X from state <settled>"), and
 *   - a state whose entry effect emits one is *transient*: it auto-advances
 *     to the emit target the instant the effect resolves (e.g. `loading`
 *     auto-advances to `browsing` on fetch success).
 *
 * Used by `extractTraitWalkConfigs` (to tag the trait) and `planWalk` (to
 * compute the transient closure of each transition's `to` state).
 *
 * @packageDocumentation
 */

import type { Effect, SExpr } from '@almadar/core';

/** Collect every event name emitted via an `emit` options object across a
 *  trait's transition effects (`Transition.effects` is the core `Effect`
 *  tuple union; option objects nest as `SExpr` record atoms). */
export function collectEffectEmittedEvents(
  transitions: ReadonlyArray<{ effects?: ReadonlyArray<Effect> }>,
): Set<string> {
  const out = new Set<string>();
  for (const t of transitions) {
    for (const eff of t.effects ?? []) collectFromNode(eff, out);
  }
  return out;
}

/** Collect the `emit.success` event of every `fetch` effect — the events that
 *  mean "the data landed", so their transition targets are *loaded* states.
 *  Narrower on purpose than {@link collectEffectEmittedEvents}, which merges
 *  success with failure and covers every effect kind. */
export function collectFetchSuccessEvents(
  transitions: ReadonlyArray<{ effects?: ReadonlyArray<Effect> }>,
): Set<string> {
  const out = new Set<string>();
  for (const t of transitions) {
    for (const eff of t.effects ?? []) collectFetchSuccessFromNode(eff, out);
  }
  return out;
}

function collectFetchSuccessFromNode(node: Effect | SExpr, out: Set<string>): void {
  if (!Array.isArray(node)) return;
  // Effect tuples are structurally SExpr arrays (see collectFromNode).
  const nodes = node as readonly SExpr[];
  if (nodes[0] === 'fetch') {
    for (const child of nodes) {
      if (child === null || typeof child !== 'object' || Array.isArray(child)) continue;
      const emit = (child as Readonly<Record<string, SExpr>>)['emit'];
      if (emit === null || typeof emit !== 'object' || Array.isArray(emit)) continue;
      const success = (emit as Readonly<Record<string, SExpr>>)['success'];
      if (typeof success === 'string' && success !== '') out.add(success);
    }
  }
  // A fetch can sit inside an `(if …)` wrapper, so keep descending.
  for (const child of nodes) collectFetchSuccessFromNode(child, out);
}

function collectFromNode(node: Effect | SExpr, out: Set<string>): void {
  if (Array.isArray(node)) {
    // Effect tuples are structurally SExpr arrays — iterate under that shape
    // (the tuple union's element type otherwise degrades to `unknown`).
    for (const child of node as readonly SExpr[]) collectFromNode(child, out);
    return;
  }
  if (node !== null && typeof node === 'object') {
    const emit = (node as Readonly<Record<string, SExpr>>)['emit'];
    if (emit !== null && typeof emit === 'object' && !Array.isArray(emit)) {
      for (const v of Object.values(emit as Readonly<Record<string, SExpr>>)) {
        if (typeof v === 'string' && v !== '') out.add(v);
      }
    }
  }
}
