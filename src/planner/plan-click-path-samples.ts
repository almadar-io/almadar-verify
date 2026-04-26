/**
 * `planClickPathSamples` — pure planner that produces one DOM-trigger
 * step per render-site so VG3 (click-path sampling) becomes part of the
 * Frame stream.
 *
 * Pre-v3.0.0 this lived in orbital as the inline `sampleClickPathsPerSite`
 * call inside `phase4-browser.ts:2191-2267`. That code held a `Page`,
 * drove DOM imperatively, and produced verdicts as it went — exactly the
 * "second imperative engine" pattern the Frame pipeline was supposed to
 * eliminate.
 *
 * The lifted shape: each render-site emits one `ExtendedWalkStep` with
 * `triggerKind: 'dom'` and `testKind: 'click-path'`. The kernel's
 * `tick` fires it via the same Driver loop. `assertClickPathSample`
 * (pure observer) reads the resulting Frame and checks whether any
 * trait's `currentState` advanced — exactly the semantic VG3 had.
 *
 * Pure. No `Page`. No DOM. Single timeline.
 *
 * @packageDocumentation
 */

import type { TraitWalkConfig } from '../engine/types.js';
import type { ExtendedWalkStep } from './types.js';

/**
 * Minimal render-site shape verify owns. Tools (orbital, runtime-verify)
 * project their schema-shape `renderSites` into this. orbital's
 * `UnifiedTraitPlan.renderSites` already carries every field; the
 * projection is a `flatMap` at the call site.
 */
export interface RenderSiteSpec {
  /** Trait that owns the render site. */
  traitName: string;
  /** Stable identifier for the (slot, pattern, propPath) tuple. */
  siteKey: string;
  /** Event the affordance dispatches when clicked. */
  event: string;
  /** UI slot the pattern renders in (`main`, `modal`, etc.). */
  slot: string;
  /** Pattern name (`button`, `data-grid`, `floating-action-button`, etc.). */
  patternType: string;
}

export interface PlanClickPathInput {
  traits: ReadonlyArray<TraitWalkConfig>;
  renderSites: ReadonlyArray<RenderSiteSpec>;
}

/**
 * One step per render-site. The step's `from`/`to` are the trait's
 * initial state — the observer only cares whether *some* trait
 * advanced from the previous frame, not whether the owning trait's
 * state matched any specific transition (cross-trait handoffs are
 * legit; e.g. cart's ADD_ITEM opens a modal owned by another trait).
 *
 * Sites for traits not present in `traits` are skipped (background
 * traits, runtime-only traits without page routes).
 */
export function planClickPathSamples(input: PlanClickPathInput): ExtendedWalkStep[] {
  const traitByName = new Map<string, TraitWalkConfig>();
  for (const trait of input.traits) {
    traitByName.set(trait.traitName, trait);
  }

  const result: ExtendedWalkStep[] = [];
  for (const site of input.renderSites) {
    const trait = traitByName.get(site.traitName);
    if (trait === undefined) continue;

    result.push({
      from: trait.initialState,
      event: site.event,
      to: trait.initialState,
      guardCase: null,
      payload: {},
      isRepositioning: false,
      traitName: trait.traitName,
      triggerKind: 'dom',
      coverageKey: `${trait.traitName}:${trait.initialState}+${site.event}->${trait.initialState}[click-path:${site.siteKey}]`,
      testKind: 'click-path',
    });
  }

  return result;
}
