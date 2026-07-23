/**
 * `assertOrbitalIsolation` — pure observer over `Frame[]` for gap #13
 * (cross-orbital trait isolation).
 *
 * Architectural contract: each orbital is bound to a page, so when a
 * trait in orbital A dispatches an event, no trait outside orbital A
 * should react — unless the source orbital declared an explicit
 * cross-orbital `listens` channel and the receiving orbital's listen
 * resolves the qualified `Orbital.Trait.Event` form.
 *
 * For each frame whose `cause.testKind` is set (i.e. the verifier
 * originated this transition, so we know which trait dispatched):
 *   - Resolve the dispatching trait's orbital from the IR.
 *   - Compare the trait state map between this frame and the previous.
 *   - Any trait whose `currentState` changed and lives in a DIFFERENT
 *     orbital is a contamination — unless covered by the declared
 *     cross-orbital allow-list.
 *
 * Defense-in-depth: by the time Phase 4 (codegen unification) and
 * Phase 5 (route-scoped subscription) are landed, the bus literally
 * can't deliver an event to a wrong-orbital subscriber. This observer
 * verifies that contract holds at runtime and reports a regression
 * directly if the codegen or route-scoping breaks.
 *
 * @packageDocumentation
 */

import type { OrbitalSchema } from '@almadar/core';
import type { Frame } from '../frame/types.js';
import type { Verdict } from './types.js';

/**
 * Build the trait-name → orbital-name map from the resolved schema.
 *
 * Inline traits carry their name on `TraitDefinition`. Reference traits
 * carry it via `name` or `ref` on the override descriptor. We accept
 * either; missing names are skipped (the L1/L2 validators reject those
 * upstream — at runtime we just don't index them).
 */
function buildOrbitalsByTrait(orbital: OrbitalSchema): Map<string, string> {
  const map = new Map<string, string>();
  for (const orb of orbital.orbitals) {
    for (const traitRef of orb.traits) {
      let name: string | undefined;
      if (typeof traitRef === 'string') {
        // Pure string form: 'TraitName' or 'Alias.traits.TraitName'.
        const parts = traitRef.split('.');
        name = parts[parts.length - 1];
      } else if ('ref' in traitRef && typeof traitRef.ref === 'string') {
        // Reference object: prefer override `name`, fall back to ref tail.
        const parts = traitRef.ref.split('.');
        name = traitRef.name ?? parts[parts.length - 1];
      } else if ('name' in traitRef && typeof traitRef.name === 'string') {
        // Inline `Trait` definition.
        name = traitRef.name;
      }
      if (name) {
        map.set(name, orb.name);
      }
    }
  }
  return map;
}

/**
 * Build the allow-list of declared cross-orbital channels:
 * `${sourceOrbital}.${sourceTrait}.${event}`. A trait that listens for
 * a qualified `Orbital.Trait.Event` form gets its receiving end added,
 * but we key on the SOURCE side because the contamination check asks
 * "did orbital X's dispatch reach orbital Y?", and X's trait+event are
 * what's known at dispatch time.
 *
 * Reads `ListenSource::Orbital { orbital, trait_name }` from typed IR
 * fields — no string parsing.
 */
function buildDeclaredCrossOrbitalChannels(orbital: OrbitalSchema): Set<string> {
  const set = new Set<string>();
  for (const orb of orbital.orbitals) {
    for (const traitRef of orb.traits) {
      // Only inline trait definitions carry `listens`. Strings and pure
      // reference objects don't override the upstream's listens.
      if (typeof traitRef !== 'object') continue;
      if (!('listens' in traitRef)) continue;
      const listens = traitRef.listens;
      if (!Array.isArray(listens)) continue;
      for (const listen of listens) {
        const source = listen.source;
        if (!source || typeof source !== 'object') continue;
        if ('kind' in source && source.kind === 'orbital') {
          // Narrowed by the discriminant: core's ListenSource 'orbital' arm
          // carries both fields as required strings.
          set.add(`${source.orbital}.${source.trait}.${listen.event}`);
        }
      }
    }
  }
  return set;
}

export function assertOrbitalIsolation(
  frames: ReadonlyArray<Frame>,
  orbital: OrbitalSchema,
): Verdict[] {
  const orbitalsByTrait = buildOrbitalsByTrait(orbital);
  const declaredChannels = buildDeclaredCrossOrbitalChannels(orbital);
  const verdicts: Verdict[] = [];

  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i];
    if (!frame.cause.testKind) continue;

    const dispatchingTrait = frame.cause.traitName;
    const dispatchingOrbital = orbitalsByTrait.get(dispatchingTrait);
    if (!dispatchingOrbital) continue;

    const prev = frames[i - 1];
    const prevStates = new Map<string, string>();
    for (const t of prev.runtimeSnapshot.traits) {
      prevStates.set(t.traitName, t.currentState);
    }

    for (const t of frame.runtimeSnapshot.traits) {
      const before = prevStates.get(t.traitName);
      if (before === undefined || before === t.currentState) continue;

      const reactingOrbital = orbitalsByTrait.get(t.traitName);
      if (!reactingOrbital || reactingOrbital === dispatchingOrbital) continue;

      const channelKey = `${dispatchingOrbital}.${dispatchingTrait}.${frame.cause.event}`;
      if (declaredChannels.has(channelKey)) continue;

      verdicts.push({
        passed: false,
        detail:
          `orbital-isolation: trait '${dispatchingTrait}' (${dispatchingOrbital}) ` +
          `dispatched '${frame.cause.event}' but trait '${t.traitName}' (${reactingOrbital}) ` +
          `reacted (${before} → ${t.currentState}) without a declared cross-orbital listen`,
        evidence: { frameIndices: [frame.index] },
      });
    }
  }

  if (verdicts.length === 0) {
    verdicts.push({
      passed: true,
      detail: 'orbital-isolation: no undeclared cross-orbital reactions observed',
      evidence: { frameIndices: [] },
    });
  }

  return verdicts;
}
