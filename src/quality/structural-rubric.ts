/**
 * Deterministic structural quality rubric for composed `.orb` schemas.
 *
 * Measures the render-tree structure of a resolved `OrbitalSchema` (per orbital
 * + aggregate) and emits facts plus advisory 0–1 subscores. Every literal
 * render `type:` token is joined against the `@almadar/core` patterns registry
 * (`getPatternDefinition` → `tier`); `@config.*` / `@`-bound type values are
 * skipped. No pass/fail verdict — advisory by construction.
 *
 * Normalization constants (calibrated against the live corpus of composed
 * free-mode schemas: median depth 4, median 6 distinct types, 2 axes, ~5
 * states; a flat single-pattern dump is depth 1–2, 1 type, 0–1 children arrays):
 *   NEST_TARGET       5   depth at which nestingDepth saturates (depth 1 → 0)
 *   DIVERSITY_TARGET  8   distinct pattern types at which diversity saturates
 *   TIER_SPAN         3   atoms/molecules/organisms — full span → tierMix 1
 *   CHILDREN_TARGET   6   static children arrays for full collection credit
 *   DYNAMIC_TARGET    2   map/renderItem collection entries for full credit
 *   LAYOUT_PROP_TARGET 6  justify+align+gap uses for full layoutIntent credit
 *   STATE_TARGET      5   states at which the interaction state term saturates
 *   GUARD_TARGET      3   guarded transitions for the interaction guard term
 */

import {
  type OrbitalSchema,
  type Trait,
  type StateMachine,
  type Transition,
  getPatternDefinition,
} from '@almadar/core';
import type {
  StructuralQualityReport,
  OrbitalStructuralFacts,
  AggregateStructuralFacts,
  TierMix,
  LayoutFacts,
  CollectionFacts,
  KnobTierFacts,
  InteractionFacts,
  PatternTierBucket,
} from './types.js';

const NEST_TARGET = 5;
const DIVERSITY_TARGET = 8;
const TIER_SPAN = 3;
const CHILDREN_TARGET = 6;
const DYNAMIC_TARGET = 2;
const LAYOUT_PROP_TARGET = 6;
const STATE_TARGET = 5;
const GUARD_TARGET = 3;

// ---------------------------------------------------------------------------
// Narrowing helpers (no casts — narrow `unknown` structurally)
// ---------------------------------------------------------------------------

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function isLiteralTypeToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('@');
}

/** A FC-5 dynamic-collection children entry: `["array/map", expr, ["fn", param, node]]`. */
function asMapChildEntry(value: unknown): UnknownRecord | null {
  if (!Array.isArray(value) || value[0] !== 'array/map' || value.length < 3) return null;
  const lambda = value[2];
  if (!Array.isArray(lambda) || lambda[0] !== 'fn' || lambda.length < 3) return null;
  return asRecord(lambda[2]);
}

/** `renderItem` may be a plain node record OR a `["fn", param, node]` lambda. */
function asRenderItemNode(value: unknown): UnknownRecord | null {
  const record = asRecord(value);
  if (record) return record;
  if (Array.isArray(value) && value[0] === 'fn' && value.length >= 3) {
    return asRecord(value[2]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Render-tree walk
// ---------------------------------------------------------------------------

interface RenderAccumulator {
  types: Set<string>;
  tierMix: TierMix;
  collection: CollectionFacts;
  layout: { axes: Set<string>; justifyUses: number; alignUses: number; gapUses: number };
}

function tierBucketFor(type: string): PatternTierBucket {
  const def = getPatternDefinition(type);
  if (!def) return 'unknown';
  switch (def.tier) {
    case 'atoms':
    case 'molecules':
    case 'organisms':
    case 'templates':
      return def.tier;
    default:
      return 'unknown';
  }
}

/** Walk one render node, updating the accumulator and returning subtree depth (this node = 1). */
function walkNode(node: UnknownRecord, acc: RenderAccumulator): number {
  const type = node.type;
  if (isLiteralTypeToken(type)) {
    acc.types.add(type);
    acc.tierMix[tierBucketFor(type)] += 1;
  }

  if (isLiteralTypeToken(node.direction)) acc.layout.axes.add(node.direction);
  if (typeof node.justify === 'string') acc.layout.justifyUses += 1;
  if (typeof node.align === 'string') acc.layout.alignUses += 1;
  if (node.gap !== undefined && node.gap !== null) acc.layout.gapUses += 1;

  let deepestChild = 0;

  const children = node.children;
  if (Array.isArray(children) && children.length > 0) {
    let sawChild = false;
    for (const entry of children) {
      const mapChild = asMapChildEntry(entry);
      if (mapChild) {
        acc.collection.mapChildren += 1;
        deepestChild = Math.max(deepestChild, walkNode(mapChild, acc));
        sawChild = true;
        continue;
      }
      const childRecord = asRecord(entry);
      if (childRecord) {
        deepestChild = Math.max(deepestChild, walkNode(childRecord, acc));
        sawChild = true;
      }
    }
    if (sawChild) acc.collection.childrenArrays += 1;
  }

  const renderItem = asRenderItemNode(node.renderItem);
  if (renderItem) {
    acc.collection.renderItemLambdas += 1;
    deepestChild = Math.max(deepestChild, walkNode(renderItem, acc));
  }

  return 1 + deepestChild;
}

/**
 * Collect every literal render-tree root reachable from a trait:
 * - the 3rd element of any `['render-ui', slot, <tree>]` effect (at any nesting
 *   depth inside effect S-expressions), skipping binding-string / null trees;
 * - `ui:` presentation-binding `content` nodes.
 */
function collectRenderRoots(trait: Trait): UnknownRecord[] {
  const roots: UnknownRecord[] = [];

  const walkForRenderUi = (value: unknown): void => {
    if (Array.isArray(value)) {
      if (value[0] === 'render-ui' && value.length >= 3) {
        const tree = asRecord(value[2]);
        if (tree) roots.push(tree);
      }
      for (const item of value) walkForRenderUi(item);
      return;
    }
    const record = asRecord(value);
    if (record) {
      for (const v of Object.values(record)) walkForRenderUi(v);
    }
  };

  if (trait.stateMachine) walkForRenderUi(trait.stateMachine.transitions);
  if (trait.initialEffects) walkForRenderUi(trait.initialEffects);
  if (trait.ticks) walkForRenderUi(trait.ticks);

  const ui = asRecord(trait.ui);
  if (ui) {
    for (const binding of Object.values(ui)) {
      const b = asRecord(binding);
      if (!b) continue;
      const content = b.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          const r = asRecord(c);
          if (r) roots.push(r);
        }
      } else {
        const r = asRecord(content);
        if (r) roots.push(r);
      }
    }
  }

  return roots;
}

// ---------------------------------------------------------------------------
// Knob-tier + interaction facts
// ---------------------------------------------------------------------------

function knobTiersFor(trait: Trait): KnobTierFacts {
  const facts: KnobTierFacts = { domain: 0, presentation: 0, other: 0, untieredValues: 0 };
  const config = asRecord(trait.config);
  if (!config) return facts;
  for (const entry of Object.values(config)) {
    const decl = asRecord(entry);
    const tier = decl && typeof decl.tier === 'string' ? decl.tier : undefined;
    if (tier === 'domain') facts.domain += 1;
    else if (tier === 'presentation') facts.presentation += 1;
    else if (tier) facts.other += 1;
    else facts.untieredValues += 1;
  }
  return facts;
}

function interactionFor(sm: StateMachine | undefined): InteractionFacts {
  if (!sm) return { states: 0, transitions: 0, guardedTransitions: 0 };
  const transitions: Transition[] = Array.isArray(sm.transitions) ? sm.transitions : [];
  const guarded = transitions.filter(
    (t) => t.guard !== undefined && t.guard !== null,
  ).length;
  return {
    states: Array.isArray(sm.states) ? sm.states.length : 0,
    transitions: transitions.length,
    guardedTransitions: guarded,
  };
}

// ---------------------------------------------------------------------------
// Subscore normalizations (monotonic, clamped to 0–1)
// ---------------------------------------------------------------------------

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const ramp = (value: number, floor: number, target: number): number =>
  target <= floor ? 0 : clamp01((value - floor) / (target - floor));

function subscoresFrom(facts: {
  maxNestingDepth: number;
  distinctPatternTypes: string[];
  tierMix: TierMix;
  collection: CollectionFacts;
  layout: LayoutFacts;
  knobTiers: KnobTierFacts;
  interaction: InteractionFacts;
}): Record<string, number> {
  const nestingDepth = ramp(facts.maxNestingDepth, 1, NEST_TARGET);
  const patternDiversity = ramp(facts.distinctPatternTypes.length, 1, DIVERSITY_TARGET);

  const tiersPresent =
    (facts.tierMix.atoms > 0 ? 1 : 0) +
    (facts.tierMix.molecules > 0 ? 1 : 0) +
    (facts.tierMix.organisms > 0 ? 1 : 0);
  const tierMix = ramp(tiersPresent, 1, TIER_SPAN);

  const collectionRendering = clamp01(
    0.5 * ramp(facts.collection.childrenArrays, 0, CHILDREN_TARGET) +
      0.5 *
        ramp(
          facts.collection.mapChildren + facts.collection.renderItemLambdas,
          0,
          DYNAMIC_TARGET,
        ),
  );

  const layoutIntent = clamp01(
    0.5 * ramp(facts.layout.axes.length, 0, 2) +
      0.5 *
        ramp(
          facts.layout.justifyUses + facts.layout.alignUses + facts.layout.gapUses,
          0,
          LAYOUT_PROP_TARGET,
        ),
  );

  const tieredKnobs = facts.knobTiers.domain + facts.knobTiers.presentation + facts.knobTiers.other;
  const domainKnobRatio = tieredKnobs === 0 ? 0 : facts.knobTiers.domain / tieredKnobs;

  const interactionDepth = clamp01(
    0.6 * ramp(facts.interaction.states, 1, STATE_TARGET) +
      0.4 * ramp(facts.interaction.guardedTransitions, 0, GUARD_TARGET),
  );

  return {
    nestingDepth,
    patternDiversity,
    tierMix,
    collectionRendering,
    layoutIntent,
    domainKnobRatio,
    interactionDepth,
  };
}

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

const emptyTierMix = (): TierMix => ({ atoms: 0, molecules: 0, organisms: 0, templates: 0, unknown: 0 });

function mergeTierMix(into: TierMix, from: TierMix): void {
  into.atoms += from.atoms;
  into.molecules += from.molecules;
  into.organisms += from.organisms;
  into.templates += from.templates;
  into.unknown += from.unknown;
}

// ---------------------------------------------------------------------------
// Per-orbital analysis
// ---------------------------------------------------------------------------

function analyzeOrbital(traits: Trait[]): OrbitalStructuralFacts {
  const acc: RenderAccumulator = {
    types: new Set<string>(),
    tierMix: emptyTierMix(),
    collection: { childrenArrays: 0, mapChildren: 0, renderItemLambdas: 0 },
    layout: { axes: new Set<string>(), justifyUses: 0, alignUses: 0, gapUses: 0 },
  };

  let maxDepth = 0;
  let renderTreeCount = 0;
  const knobTiers: KnobTierFacts = { domain: 0, presentation: 0, other: 0, untieredValues: 0 };
  const interaction: InteractionFacts = { states: 0, transitions: 0, guardedTransitions: 0 };

  for (const trait of traits) {
    for (const root of collectRenderRoots(trait)) {
      renderTreeCount += 1;
      maxDepth = Math.max(maxDepth, walkNode(root, acc));
    }
    const kt = knobTiersFor(trait);
    knobTiers.domain += kt.domain;
    knobTiers.presentation += kt.presentation;
    knobTiers.other += kt.other;
    knobTiers.untieredValues += kt.untieredValues;

    const it = interactionFor(trait.stateMachine);
    interaction.states += it.states;
    interaction.transitions += it.transitions;
    interaction.guardedTransitions += it.guardedTransitions;
  }

  const layout: LayoutFacts = {
    axes: [...acc.layout.axes],
    justifyUses: acc.layout.justifyUses,
    alignUses: acc.layout.alignUses,
    gapUses: acc.layout.gapUses,
  };

  const base = {
    maxNestingDepth: maxDepth,
    distinctPatternTypes: [...acc.types].sort(),
    tierMix: acc.tierMix,
    collection: acc.collection,
    layout,
    knobTiers,
    interaction,
  };

  return { ...base, renderTreeCount, subscores: subscoresFrom(base) };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score the structural quality of a composed `OrbitalSchema`. Deterministic:
 * same schema → same report. Facts + advisory 0–1 subscores; no verdict.
 */
export function scoreStructuralQuality(schema: OrbitalSchema): StructuralQualityReport {
  const orbitals: Record<string, OrbitalStructuralFacts> = {};

  const aggTypes = new Set<string>();
  const aggTierMix = emptyTierMix();
  const aggCollection: CollectionFacts = { childrenArrays: 0, mapChildren: 0, renderItemLambdas: 0 };
  const aggAxes = new Set<string>();
  const aggLayout = { justifyUses: 0, alignUses: 0, gapUses: 0 };
  const aggKnobTiers: KnobTierFacts = { domain: 0, presentation: 0, other: 0, untieredValues: 0 };
  const aggInteraction: InteractionFacts = { states: 0, transitions: 0, guardedTransitions: 0 };
  let aggMaxDepth = 0;
  let aggRenderTrees = 0;

  const orbitalList = Array.isArray(schema.orbitals) ? schema.orbitals : [];
  orbitalList.forEach((orbital, index) => {
    const orb = asRecord(orbital);
    const traits: Trait[] =
      orb && Array.isArray(orb.traits)
        ? orb.traits.filter((t): t is Trait => asRecord(t) !== null && typeof (t as Trait).name === 'string')
        : [];
    const name =
      orb && typeof orb.name === 'string' && orb.name.length > 0 ? orb.name : `orbital-${index}`;

    const facts = analyzeOrbital(traits);
    orbitals[name] = facts;

    for (const t of facts.distinctPatternTypes) aggTypes.add(t);
    mergeTierMix(aggTierMix, facts.tierMix);
    aggCollection.childrenArrays += facts.collection.childrenArrays;
    aggCollection.mapChildren += facts.collection.mapChildren;
    aggCollection.renderItemLambdas += facts.collection.renderItemLambdas;
    for (const axis of facts.layout.axes) aggAxes.add(axis);
    aggLayout.justifyUses += facts.layout.justifyUses;
    aggLayout.alignUses += facts.layout.alignUses;
    aggLayout.gapUses += facts.layout.gapUses;
    aggKnobTiers.domain += facts.knobTiers.domain;
    aggKnobTiers.presentation += facts.knobTiers.presentation;
    aggKnobTiers.other += facts.knobTiers.other;
    aggKnobTiers.untieredValues += facts.knobTiers.untieredValues;
    aggInteraction.states += facts.interaction.states;
    aggInteraction.transitions += facts.interaction.transitions;
    aggInteraction.guardedTransitions += facts.interaction.guardedTransitions;
    aggMaxDepth = Math.max(aggMaxDepth, facts.maxNestingDepth);
    aggRenderTrees += facts.renderTreeCount;
  });

  const aggregateBase = {
    maxNestingDepth: aggMaxDepth,
    distinctPatternTypes: [...aggTypes].sort(),
    tierMix: aggTierMix,
    collection: aggCollection,
    layout: {
      axes: [...aggAxes],
      justifyUses: aggLayout.justifyUses,
      alignUses: aggLayout.alignUses,
      gapUses: aggLayout.gapUses,
    },
    knobTiers: aggKnobTiers,
    interaction: aggInteraction,
  };

  const aggregate: AggregateStructuralFacts = {
    orbitalCount: orbitalList.length,
    renderTreeCount: aggRenderTrees,
    knobTierMetadataPresent:
      aggKnobTiers.domain + aggKnobTiers.presentation + aggKnobTiers.other > 0,
    ...aggregateBase,
  };

  return { orbitals, aggregate, subscores: subscoresFrom(aggregateBase) };
}
