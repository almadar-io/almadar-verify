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
import { collectTraitEmbedAdjacency, isInlineTrait, isPageReference } from '@almadar/core';
import type { WalkTransition } from '../../engine/types.js';

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
 * Project a core `Transition` into the kernel walker's `WalkTransition`.
 */
export function toEdgeWalkTransition(t: Transition): WalkTransition {
  const hasGuard = t.guard !== undefined && t.guard !== null;
  const out: WalkTransition = { from: t.from, event: t.event, to: t.to, hasGuard };
  // Firing this transition can swap the page (trait unmounts) — the
  // dispatch-error gate accepts a null post-dispatch state read for it.
  if ((t.effects ?? []).some((e) => Array.isArray(e) && e[0] === 'navigate')) {
    out.navigates = true;
  }
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

/** Per-orbital page-closure memo: for each page (decl order), the page's
 *  declared traits plus their transitive `@trait.X` embed closure — the
 *  exact set the client binds while that page is mounted. */
const pageClosureMemo = new WeakMap<Orbital, ReadonlyArray<{ route: string; closure: ReadonlySet<string> }>>();

function pageClosures(orb: Orbital): ReadonlyArray<{ route: string; closure: ReadonlySet<string> }> {
  const cached = pageClosureMemo.get(orb);
  if (cached !== undefined) return cached;
  const adjacency = collectTraitEmbedAdjacency(orb);
  const out: Array<{ route: string; closure: ReadonlySet<string> }> = [];
  for (const ref of orb.pages ?? []) {
    const path = pagePath(ref);
    if (path === null) continue;
    const traits = pageTraits(ref);
    if (traits === null) continue;
    const closure = new Set<string>();
    const queue: string[] = [];
    for (const t of traits) {
      const name = traitRefName(t);
      if (name !== null && !closure.has(name)) {
        closure.add(name);
        queue.push(name);
      }
    }
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined) break;
      for (const child of adjacency.get(current) ?? []) {
        if (!closure.has(child)) {
          closure.add(child);
          queue.push(child);
        }
      }
    }
    out.push({ route: normalizeRoute(path), closure });
  }
  pageClosureMemo.set(orb, out);
  return out;
}

/**
 * Route for a trait bound only through a page's `@trait.X` embed closure
 * (an inline chrome child of a page-declared composer, itself in no page
 * decl). The client binds exactly the page decl + closure per mounted page
 * (`OrbPreview.allPageTraits`), so probing such a trait anywhere else finds
 * no state machine — this is the walker's mirror of that rule.
 */
export function findRouteForEmbedClosure(orb: Orbital, traitName: string): string | null {
  for (const { route, closure } of pageClosures(orb)) {
    if (closure.has(traitName)) return route;
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
  return traitRefName(ref) === traitName;
}

/** The referenced trait name of a page/orbital `TraitRef`, any form. */
function traitRefName(ref: TraitRef): string | null {
  if (typeof ref === 'string') return ref;
  if (ref !== null && typeof ref === 'object') {
    if ('ref' in ref && typeof ref.ref === 'string') return ref.ref;
    if ('name' in ref && typeof ref.name === 'string') return ref.name;
  }
  return null;
}

function normalizeRoute(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}
