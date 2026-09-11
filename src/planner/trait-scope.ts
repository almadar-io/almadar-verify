/**
 * `--trait NAME` scoping — resolve one or more trait names against a
 * schema's inline traits (owner ruling 2026-09-11: verification is one
 * trait at a time). Mirrors the rust engine's already-landed
 * `orbital-verify::planner::{trait_matches_name, resolve_trait_names}`
 * (`orbital-rust/crates/orbital-verify/src/planner.rs`) so a name that
 * resolves for `orb verify --trait` resolves identically here.
 *
 * @packageDocumentation
 */

import type { OrbitalSchema, Trait } from '@almadar/core';
import { eachInlineTrait } from './internal/orbital-walk.js';

/**
 * `name` matches `trait`'s resolved (possibly orbital-prefixed) name, OR
 * the bare name it was authored/imported under
 * (`sourceBehavior.originalName`) — the same two spellings a trait can
 * carry post-resolve that the rust planner accepts.
 */
export function traitMatchesName(trait: Trait, name: string): boolean {
  return trait.name === name || trait.sourceBehavior?.originalName === name;
}

/** The name to show for `trait` in an error/available-traits listing. */
function traitDisplayName(trait: Trait): string {
  return trait.sourceBehavior?.originalName ?? trait.name;
}

/**
 * Resolve `--trait` names against every inline trait in `orbital`,
 * returning the CANONICAL resolved (`trait.name`) set, deduplicated, in
 * first-match order. A name matching no trait is an error listing every
 * available trait name — never a silent no-op.
 */
export function resolveTraitNames(orbital: OrbitalSchema, names: readonly string[]): string[] {
  const all = [...eachInlineTrait(orbital)].map(({ trait }) => trait);
  const resolved: string[] = [];
  for (const name of names) {
    let found = false;
    for (const trait of all) {
      if (traitMatchesName(trait, name)) {
        found = true;
        if (!resolved.includes(trait.name)) resolved.push(trait.name);
      }
    }
    if (!found) {
      const available = [...new Set(all.map(traitDisplayName))].sort();
      throw new Error(`unknown --trait "${name}" — available traits: ${available.join(', ')}`);
    }
  }
  return resolved;
}
