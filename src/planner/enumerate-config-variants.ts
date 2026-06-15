/**
 * Enumerate config variants for a Storybook-style sweep.
 *
 * Given a trait's declared `config` schema, produce a list of override sets —
 * one axis at a time (vary a single field from the baseline of defaults) to
 * avoid combinatorial blow-up. Booleans flip both ways, string enums walk their
 * declared `values`, numbers sample a few representative magnitudes. Non-scalar
 * fields (free strings, arrays, objects) are not swept.
 *
 * @packageDocumentation
 */

import type {
  DeclaredTraitConfig,
  ConfigFieldDeclaration,
  TraitConfig,
  TraitConfigValue,
} from '@almadar/core';

export interface ConfigVariant {
  /** Human-readable label, e.g. `format = bar`. */
  readonly label: string;
  /** The single field varied from baseline. */
  readonly field: string;
  /** Full override set: the baseline defaults with `field` changed. */
  readonly config: TraitConfig;
}

function baselineDefaults(config: DeclaredTraitConfig): Record<string, TraitConfigValue> {
  const base: Record<string, TraitConfigValue> = {};
  for (const [name, decl] of Object.entries(config)) {
    if (decl.default !== undefined) base[name] = decl.default;
  }
  return base;
}

function candidateValues(decl: ConfigFieldDeclaration): TraitConfigValue[] {
  if (decl.type === 'boolean') return [true, false];
  if (decl.type === 'string' && decl.values !== undefined && decl.values.length > 0) {
    return [...decl.values];
  }
  if (decl.type === 'number') {
    const out = new Set<number>([0, 25, 50, 100]);
    if (typeof decl.default === 'number' && decl.default > 0) out.add(decl.default);
    return [...out];
  }
  return [];
}

function format(value: TraitConfigValue): string {
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** One-axis-at-a-time variants for the trait's declared config. */
export function enumerateConfigVariants(config: DeclaredTraitConfig): ConfigVariant[] {
  const base = baselineDefaults(config);
  const variants: ConfigVariant[] = [];
  for (const [name, decl] of Object.entries(config)) {
    for (const value of candidateValues(decl)) {
      if (value === decl.default) continue; // skip the no-op baseline value
      variants.push({ label: `${name} = ${format(value)}`, field: name, config: { ...base, [name]: value } });
    }
  }
  return variants;
}
