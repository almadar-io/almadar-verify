/**
 * `planContractEvents` — pure planner that produces one DOM-trigger
 * step per declared cross-orbital contract emit so Phase 4c becomes
 * part of the Frame stream.
 *
 * Reads the parsed `OrbitalSchema` directly + a contract registry
 * (`pattern → emits`) the consumer loads from `event-contracts.json`.
 * For each pattern that appears in any trait's render-ui (so it'll
 * render in the running app) AND has registered emits in the registry,
 * each non-optional emit becomes one step.
 *
 * Pure. No filesystem, no DOM.
 *
 * @packageDocumentation
 */

import type { OrbitalSchema, SExpr } from '@almadar/core';
import type { ExtendedWalkStep } from './types.js';
import { eachInlineTrait, findInitialState } from './internal/orbital-walk.js';

export interface ContractRegistryEntry {
  emits: ReadonlyArray<{ event: string; optional?: boolean }>;
  entityAware?: boolean;
}

export type ContractRegistry = Record<string, ContractRegistryEntry>;

export function planContractEvents(
  orbital: OrbitalSchema,
  registry: ContractRegistry,
  alreadyCovered?: ReadonlySet<string>,
): ExtendedWalkStep[] {
  const result: ExtendedWalkStep[] = [];
  const seenEvents = new Set<string>();

  // Collect every pattern actually used in any render-ui across the orbital.
  const patternsInUse = collectPatternsInUse(orbital);

  // Pick an anchor trait (first inline trait with a state machine).
  // All contract steps are anchored under it for routing — Phase 4c
  // events fire from the global bus, so the trait routing is just the
  // kernel's "where am I right now" hint.
  const anchor = pickAnchor(orbital);
  if (anchor === null) return [];

  for (const patternName of patternsInUse) {
    const entry = registry[patternName];
    if (entry === undefined) continue;
    for (const emit of entry.emits) {
      if (emit.optional === true) continue;
      if (seenEvents.has(emit.event)) continue;
      if (alreadyCovered?.has(emit.event) === true) continue;
      seenEvents.add(emit.event);

      result.push({
        from: anchor.initialState,
        event: emit.event,
        to: anchor.initialState,
        guardCase: null,
        payload: {},
        isRepositioning: false,
        traitName: anchor.traitName,
        triggerKind: 'dom',
        coverageKey: `${anchor.traitName}:${anchor.initialState}+${emit.event}->${anchor.initialState}[contract:${patternName}]`,
        testKind: 'contract',
      });
    }
  }

  return result;
}

// ── internal ─────────────────────────────────────────────────────────

interface Anchor {
  traitName: string;
  initialState: string;
}

function pickAnchor(orbital: OrbitalSchema): Anchor | null {
  for (const { trait } of eachInlineTrait(orbital)) {
    if (trait.stateMachine === undefined) continue;
    const initial = findInitialState(trait.stateMachine);
    if (initial === null) continue;
    return { traitName: trait.name, initialState: initial };
  }
  return null;
}

function collectPatternsInUse(orbital: OrbitalSchema): Set<string> {
  const out = new Set<string>();
  for (const { trait } of eachInlineTrait(orbital)) {
    if (trait.stateMachine === undefined) continue;
    for (const transition of trait.stateMachine.transitions) {
      for (const effect of transition.effects ?? []) {
        if (!Array.isArray(effect)) continue;
        if (effect[0] !== 'render-ui') continue;
        collectPatternTypes(effect[2] as SExpr, out);
      }
    }
  }
  return out;
}

function collectPatternTypes(node: SExpr, out: Set<string>): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) collectPatternTypes(child, out);
    return;
  }
  const obj = node as Readonly<Record<string, SExpr>>;
  const patternType = obj['type'];
  if (typeof patternType === 'string') out.add(patternType);
  for (const value of Object.values(obj)) collectPatternTypes(value, out);
}
