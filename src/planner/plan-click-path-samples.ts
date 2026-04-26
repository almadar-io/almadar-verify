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

import type { OrbitalSchema } from '@almadar/core';
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

        result.push({
          from: initial,
          event: site.event,
          to: initial,
          guardCase: null,
          payload: {},
          isRepositioning: false,
          traitName: trait.name,
          triggerKind: 'dom',
          coverageKey: `${trait.name}:${initial}+${site.event}->${initial}[click-path:${site.slot}]`,
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
}

/**
 * Walk a trait's transition effects looking for `render-ui` effects
 * whose UI payload references actionable events (`action: "EVENT_KEY"`).
 * Each (slot, event) pair is one render site.
 */
function collectRenderSites(trait: { stateMachine?: { transitions: ReadonlyArray<{ effects?: ReadonlyArray<unknown> }> } }): RenderSite[] {
  const sites: RenderSite[] = [];
  if (trait.stateMachine === undefined) return sites;

  for (const transition of trait.stateMachine.transitions) {
    for (const effect of transition.effects ?? []) {
      if (!Array.isArray(effect)) continue;
      if (effect[0] !== 'render-ui') continue;
      // Shape: ['render-ui', slot, uiPayload]
      const slot = typeof effect[1] === 'string' ? effect[1] : null;
      const uiPayload = effect[2];
      if (slot === null || uiPayload === undefined) continue;
      collectActionsFromUI(uiPayload, slot, sites);
    }
  }

  return sites;
}

/** Recursively walk a render-ui payload looking for `action: "<EVENT>"` fields. */
function collectActionsFromUI(node: unknown, slot: string, out: RenderSite[]): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) collectActionsFromUI(child, slot, out);
    return;
  }
  const obj = node as { action?: unknown; children?: unknown; fields?: unknown; [k: string]: unknown };
  if (typeof obj.action === 'string' && obj.action.length > 0) {
    out.push({ slot, event: obj.action });
  }
  // Recurse into common nested-children fields.
  if (obj.children !== undefined) collectActionsFromUI(obj.children, slot, out);
  if (obj.fields !== undefined) collectActionsFromUI(obj.fields, slot, out);
  // Generic recursion through every value (for nested patterns like `cta`, `header`, etc.).
  for (const key of Object.keys(obj)) {
    if (key === 'action' || key === 'children' || key === 'fields') continue;
    collectActionsFromUI(obj[key], slot, out);
  }
}
