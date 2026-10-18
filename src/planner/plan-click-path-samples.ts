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
import { establishFromPrecondition } from '../kernel/adapt.js';
import type { KernelPlanner } from '../kernel/kernel-planner.js';

/**
 * The browser half of click-path sampling: find the buttons the render tree mounts (each `action: "EVENT"` in a
 * state's `render-ui`), then ask the kernel what clicking each one does: where the machine lands, whether the page
 * navigates, and the preamble a guarded affordance needs.
 */
export async function planClickPathSamples(kernel: KernelPlanner, orbital: OrbitalSchema): Promise<ExtendedWalkStep[]> {
  const result: ExtendedWalkStep[] = [];
  const seen = new Set<string>();

  for (const orb of orbital.orbitals) {
    for (const traitRef of orb.traits ?? []) {
      if (!isInlineTrait(traitRef)) continue;
      const trait = traitRef;
      if (trait.stateMachine === undefined) continue;
      if (findInitialState(trait.stateMachine) === null) continue;

      for (const site of collectRenderSites(trait)) {
        const dedupeKey = `${trait.name}::${site.slot}::${site.event}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        // The step starts from the state whose render-ui mounts the button (`site.state`): a click while the dialog
        // is still closed finds no button and reports a spurious dead key.
        const affordance = await kernel.affordance(orbital, { trait: trait.name, from: site.state, event: site.event });
        if (affordance === null) continue;
        result.push({
          from: affordance.from,
          event: affordance.event,
          to: affordance.to,
          guardCase: null,
          payload: {},
          isRepositioning: false,
          traitName: affordance.trait,
          triggerKind: 'dom',
          coverageKey: affordance.coverageKey.replace(/\[affordance\]$/, `[click-path:${site.slot}]`),
          testKind: 'click-path',
          ...(affordance.navigates ? { navigates: true } : {}),
          ...establishFromPrecondition(affordance.precondition),
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
