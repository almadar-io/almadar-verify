/**
 * Internal orbital-walking helpers shared by the v3.0.0 planners.
 *
 * Each planner consumes the parsed `OrbitalSchema` directly; these
 * helpers handle the cross-cutting "find the initial state", "iterate
 * inline traits", "extract trait route" derivations.
 *
 * All pure. All operate on `@almadar/core` types. No `unknown` escape
 * hatches.
 *
 * @packageDocumentation
 */

import type {
  EdgeWalkTransition,
  Orbital,
  OrbitalSchema,
  Page,
  PageRef,
  PageRefObject,
  StateMachine,
  Trait,
  TraitRef,
  Transition,
} from '@almadar/core';
import { isInlineTrait, isPageReference } from '@almadar/core';

/**
 * Initial state for a state machine: the first state with `isInitial: true`,
 * or the first state in the array if none are flagged.
 */
export function findInitialState(sm: StateMachine): string | null {
  const explicit = sm.states.find((s) => s.isInitial === true);
  if (explicit !== undefined) return explicit.name;
  return sm.states[0]?.name ?? null;
}

/**
 * Iterate every inline `Trait` (skipping string refs and PageRef objects)
 * across every orbital in the schema, yielding the orbital + trait pair
 * so callers can correlate routes / entity context.
 */
export function* eachInlineTrait(orbital: OrbitalSchema): Generator<{ orb: Orbital; trait: Trait }> {
  for (const orb of orbital.orbitals) {
    for (const traitRef of orb.traits ?? []) {
      if (!isInlineTrait(traitRef)) continue;
      yield { orb, trait: traitRef };
    }
  }
}

/**
 * Slots a trait's boot transition renders into: the literal
 * `(initialState, INIT)` transition's `render-ui` effects. Portal-only /
 * dynamic-slot atoms (std-modal: fetches at INIT but only ever renders
 * into `@config.detailSlot` from a later user-driven OPEN) declare no
 * render-ui here — the empty set is the schema's own signal that this
 * trait promises nothing at boot, for any slot. Callers use this to
 * derive slot exemptions from the schema instead of a name/category list.
 */
export function traitBootRenderSlots(trait: Trait): Set<string> {
  const slots = new Set<string>();
  if (trait.stateMachine === undefined) return slots;
  const initialState = findInitialState(trait.stateMachine);
  if (initialState === null) return slots;
  for (const transition of trait.stateMachine.transitions) {
    if (transition.from !== initialState || transition.event !== 'INIT') continue;
    for (const effect of transition.effects ?? []) {
      if (Array.isArray(effect) && effect[0] === 'render-ui' && typeof effect[1] === 'string') {
        slots.add(effect[1]);
      }
    }
  }
  return slots;
}

/**
 * Project a core `Transition` into the kernel walker's `EdgeWalkTransition`.
 */
export function toEdgeWalkTransition(t: Transition): EdgeWalkTransition {
  const hasGuard = t.guard !== undefined && t.guard !== null;
  const out: EdgeWalkTransition = { from: t.from, event: t.event, to: t.to, hasGuard };
  // Pass through the guard regardless of whether it's an array (S-expr
  // call like `["or", ...]`, `["=", ...]`) or a string atom (bare-
  // binding existence check like `"@payload.row"` declared by
  // std-confirmation). Pre-fix, the `Array.isArray` filter dropped
  // every string-form guard, so `buildGuardPayloads` saw no guard for
  // single-binding transitions and synthesized `{}` for the pass-case
  // bus replay — modal stayed closed and the portal observer reported
  // "slot not mounted" for every single-binding-guarded event.
  if (hasGuard && t.guard !== undefined && t.guard !== null) {
    out.guard = t.guard;
  }
  return out;
}

/**
 * Find the route for a trait by scanning the orbital's `pages[]` for one
 * that references this trait by name. Returns the page's path
 * (normalized — leading slash stripped) or `null`.
 */
export function findRouteForTrait(orb: Orbital, traitName: string): string | null {
  for (const ref of orb.pages ?? []) {
    const path = pagePath(ref);
    if (path === null) continue;
    const traits = pageTraits(ref);
    if (traits === null) continue;
    for (const t of traits) {
      if (traitRefMatches(t, traitName)) return normalizeRoute(path);
    }
  }
  return null;
}

/** Default route for an orbital when no per-trait page references exist: first page with a path. */
export function findDefaultRoute(orb: Orbital): string | null {
  for (const ref of orb.pages ?? []) {
    const path = pagePath(ref);
    if (path !== null) return normalizeRoute(path);
  }
  return null;
}

// ── PageRef narrowing ───────────────────────────────────────────────

function pagePath(ref: PageRef): string | null {
  if (isPageReference(ref)) {
    if (typeof ref === 'string') return null;
    const obj: PageRefObject = ref;
    return typeof obj.path === 'string' && obj.path.length > 0 ? obj.path : null;
  }
  const page: Page = ref;
  return typeof page.path === 'string' && page.path.length > 0 ? page.path : null;
}

function pageTraits(ref: PageRef): ReadonlyArray<TraitRef> | null {
  if (isPageReference(ref)) {
    if (typeof ref === 'string') return null;
    return (ref as PageRefObject).traits ?? null;
  }
  const page: Page = ref;
  return page.traits ?? null;
}

function traitRefMatches(ref: TraitRef, traitName: string): boolean {
  if (typeof ref === 'string') return ref === traitName;
  if (ref !== null && typeof ref === 'object') {
    if ('ref' in ref && typeof ref.ref === 'string') return ref.ref === traitName;
    if ('name' in ref && typeof ref.name === 'string') return ref.name === traitName;
  }
  return false;
}

function normalizeRoute(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}
