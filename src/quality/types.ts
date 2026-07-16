/**
 * Structural-quality report types.
 *
 * Deterministic, advisory-by-construction: facts + named 0–1 subscores, never
 * a pass/fail verdict. Every render `type:` token is joined against the
 * `@almadar/core` patterns registry (the single source of `tier`/`category`).
 */

/** Registry-tier bucket for a render `type:` token. `unknown` = not in registry. */
export type PatternTierBucket =
  | 'atoms'
  | 'molecules'
  | 'organisms'
  | 'templates'
  | 'unknown';

/** Counts of render `type:` tokens bucketed by their registry tier. */
export interface TierMix {
  atoms: number;
  molecules: number;
  organisms: number;
  templates: number;
  /** Tokens with no registry entry (counted, never errors). */
  unknown: number;
}

/** Layout-intent facts gathered from render-node layout props. */
export interface LayoutFacts {
  /** Distinct direction axes seen (`vertical` / `horizontal`). */
  axes: string[];
  justifyUses: number;
  alignUses: number;
  gapUses: number;
}

/** Collection-rendering facts. */
export interface CollectionFacts {
  /** Nodes carrying a non-empty static `children:[…]` array. */
  childrenArrays: number;
  /** `["array/map", <expr>, ["fn", param, node]]` children entries (FC-5). */
  mapChildren: number;
  /** `renderItem` per-item lambdas. */
  renderItemLambdas: number;
}

/** Config-knob tier facts surfaced by the composed schema (declaration knobs). */
export interface KnobTierFacts {
  domain: number;
  presentation: number;
  /** Tiered knobs whose tier is neither `domain` nor `presentation`
   *  (`policy`/`infra`/`internal`/…). */
  other: number;
  /** Config knobs present as plain values (no tier metadata to bucket). */
  untieredValues: number;
}

/** Interaction facts from a trait's state machine. */
export interface InteractionFacts {
  states: number;
  transitions: number;
  guardedTransitions: number;
}

/** Per-orbital structural facts + local subscores. */
export interface OrbitalStructuralFacts {
  /** Max render-tree nesting depth across the orbital's render trees (root = 1). */
  maxNestingDepth: number;
  /** Number of literal render trees analysed (render-ui + ui-binding roots). */
  renderTreeCount: number;
  /** Distinct literal pattern `type:` tokens (registry-joined + unknown). */
  distinctPatternTypes: string[];
  tierMix: TierMix;
  collection: CollectionFacts;
  layout: LayoutFacts;
  knobTiers: KnobTierFacts;
  interaction: InteractionFacts;
  /** This orbital's named 0–1 subscores. */
  subscores: Record<string, number>;
}

/** Schema-wide facts, summed / merged across orbitals. */
export interface AggregateStructuralFacts {
  orbitalCount: number;
  maxNestingDepth: number;
  renderTreeCount: number;
  distinctPatternTypes: string[];
  tierMix: TierMix;
  collection: CollectionFacts;
  layout: LayoutFacts;
  knobTiers: KnobTierFacts;
  interaction: InteractionFacts;
  /** True when the composed schema surfaced ANY tiered config knob. When
   *  false, `subscores.domainKnobRatio` is 0 by absence, not by measurement —
   *  see the note recorded on the report consumer side. */
  knobTierMetadataPresent: boolean;
}

/**
 * Full structural-quality report. `subscores` are the schema-level (aggregate)
 * named 0–1 values; each orbital additionally carries its own `subscores`.
 * NO pass/fail field — advisory by construction.
 */
export interface StructuralQualityReport {
  orbitals: Record<string, OrbitalStructuralFacts>;
  aggregate: AggregateStructuralFacts;
  subscores: Record<string, number>;
}
