/**
 * `planClickPathSamples` — pure planner that produces one DOM-trigger
 * step per render-site so VG3 (click-path sampling) becomes part of the
 * Frame stream.
 *
 * Reads the parsed `OrbitalSchema` directly: walks each trait's
 * `stateMachine.transitions[].effects[]` looking for `render-ui`
 * effects whose payload includes button-shaped child patterns
 * (anything with an `action` field). Each (trait, event, slot) tuple
 * becomes one step.
 *
 * Pure. No `Page`, no DOM, no schema-side helpers — operates on the
 * typed `@almadar/core` `OrbitalSchema`.
 *
 * @packageDocumentation
 */

import type { Effect, OrbitalSchema, SExpr } from '@almadar/core';
import { isInlineTrait } from '@almadar/core';
import type { ExtendedWalkStep } from './types.js';
import { findInitialState } from './internal/orbital-walk.js';

export function planClickPathSamples(orbital: OrbitalSchema): ExtendedWalkStep[] {
  const result: ExtendedWalkStep[] = [];
  const seen = new Set<string>();

  for (const orb of orbital.orbitals) {
    for (const traitRef of orb.traits ?? []) {
      if (!isInlineTrait(traitRef)) continue;
      const trait = traitRef;
      if (trait.stateMachine === undefined) continue;
      const initial = findInitialState(trait.stateMachine);
      if (initial === null) continue;

      const sites = collectRenderSites(trait);
      for (const site of sites) {
        const dedupeKey = `${trait.name}::${site.slot}::${site.event}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        // The step must start from the state whose render-ui actually
        // mounts the button (`site.state` = the `to` of the transition
        // carrying the render effect). Stamping `initial` dispatched
        // e.g. CANCEL while the dialog was still closed — the button was
        // never visible, the bus fallback fired an event with no
        // transition from `idle`, and VG3 reported a spurious dead key.
        const target = findTransitionTarget(trait, site.state, site.event) ?? site.state;
        result.push({
          from: site.state,
          event: site.event,
          to: target,
          guardCase: null,
          payload: {},
          isRepositioning: false,
          traitName: trait.name,
          triggerKind: 'dom',
          coverageKey: `${trait.name}:${site.state}+${site.event}->${target}[click-path:${site.slot}]`,
          testKind: 'click-path',
        });
      }
    }
  }

  return result;
}

interface RenderSite {
  slot: string;
  event: string;
  /** State the render-ui is active in (the `to` of the transition carrying the effect). */
  state: string;
}

/**
 * Walk a trait's transition effects looking for `render-ui` effects
 * whose UI payload references actionable events (`action: "EVENT_KEY"`).
 * Each (slot, event) pair is one render site, stamped with the state
 * the button is mounted in.
 */
function collectRenderSites(trait: { stateMachine?: { transitions: ReadonlyArray<{ to?: string; effects?: ReadonlyArray<Effect> }> } }): RenderSite[] {
  const sites: RenderSite[] = [];
  if (trait.stateMachine === undefined) return sites;

  for (const transition of trait.stateMachine.transitions) {
    if (typeof transition.to !== 'string') continue;
    for (const effect of transition.effects ?? []) {
      if (!Array.isArray(effect)) continue;
      if (effect[0] !== 'render-ui') continue;
      // Shape: ['render-ui', slot, uiPayload]
      const slot = typeof effect[1] === 'string' ? effect[1] : null;
      const uiPayload = effect[2];
      if (slot === null || uiPayload === undefined) continue;
      collectActionsFromUI(uiPayload as SExpr, slot, transition.to, sites);
    }
  }

  return sites;
}

/** The declared target of `<event>` from `from`, when the trait declares such a transition. */
function findTransitionTarget(
  trait: { stateMachine?: { transitions: ReadonlyArray<{ from?: string; event?: string; to?: string }> } },
  from: string,
  event: string,
): string | undefined {
  const transition = trait.stateMachine?.transitions.find(
    (t) => t.from === from && t.event === event,
  );
  return typeof transition?.to === 'string' ? transition.to : undefined;
}

/** Recursively walk a render-ui payload looking for `action: "<EVENT>"` fields. */
function collectActionsFromUI(node: SExpr, slot: string, state: string, out: RenderSite[]): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) collectActionsFromUI(child, slot, state, out);
    return;
  }
  const obj = node as Readonly<Record<string, SExpr>>;
  const action = obj['action'];
  if (typeof action === 'string' && action.length > 0) {
    out.push({ slot, event: action, state });
  }
  // Recurse into common nested-children fields.
  if (obj['children'] !== undefined) collectActionsFromUI(obj['children'], slot, state, out);
  if (obj['fields'] !== undefined) collectActionsFromUI(obj['fields'], slot, state, out);
  // Generic recursion through every value (for nested patterns like `cta`, `header`, etc.).
  for (const key of Object.keys(obj)) {
    if (key === 'action' || key === 'children' || key === 'fields') continue;
    collectActionsFromUI(obj[key], slot, state, out);
  }
}
