/**
 * Config sweep — drive a trait through its config variants and snapshot each.
 *
 * The "play/variants" half of the Storybook model: for each variant produced by
 * `enumerateConfigVariants`, apply it via the driver (`applyConfig`, which on the
 * playground re-registers + re-renders), settle, and capture a screenshot. The
 * behavior's code is untouched — only its `config` values change. Browser-safe.
 *
 * @packageDocumentation
 */

import type { OrbitalSchema, DeclaredTraitConfig, TraitConfig } from '@almadar/core';
import type { Driver, DriverContext } from '../driver/types.js';
import { enumerateConfigVariants } from '../planner/enumerate-config-variants.js';

export interface ConfigSweepInput<Ctx extends DriverContext> {
  readonly orbital: OrbitalSchema;
  readonly driver: Driver<Ctx>;
  readonly ctx: Ctx;
  /** Trait to sweep. Defaults to the first trait with a non-empty declared config. */
  readonly traitName?: string;
  /** Safety cap on the number of variants (default 24). */
  readonly maxVariants?: number;
  readonly log?: (msg: string) => void;
}

export interface ConfigSweepVariant {
  readonly label: string;
  readonly field: string;
  readonly config: TraitConfig;
  readonly screenshotPath: string | null;
  readonly error?: string;
}

export interface ConfigSweepResult {
  readonly traitName: string | null;
  readonly variants: ConfigSweepVariant[];
}

function findSweepTrait(
  orbital: OrbitalSchema,
  traitName: string | undefined,
): { name: string; config: DeclaredTraitConfig } | null {
  for (const orb of orbital.orbitals) {
    for (const trait of orb.traits) {
      if (typeof trait !== 'object' || trait === null || !('scope' in trait)) continue;
      if (trait.config === undefined || Object.keys(trait.config).length === 0) continue;
      if (traitName !== undefined && trait.name !== traitName) continue;
      return { name: trait.name, config: trait.config };
    }
  }
  return null;
}

export async function runConfigSweep<Ctx extends DriverContext>(
  input: ConfigSweepInput<Ctx>,
): Promise<ConfigSweepResult> {
  const { orbital, driver, ctx, traitName, maxVariants = 24, log } = input;

  const target = findSweepTrait(orbital, traitName);
  if (target === null) {
    log?.('config sweep: no trait with declared config found');
    return { traitName: null, variants: [] };
  }
  if (driver.applyConfig === undefined) {
    log?.('config sweep: driver does not support applyConfig');
    return { traitName: target.name, variants: [] };
  }

  const all = enumerateConfigVariants(target.config);
  const variants = all.slice(0, maxVariants);
  if (all.length > variants.length) {
    log?.(`config sweep: capped ${all.length} variants to ${variants.length}`);
  }

  const results: ConfigSweepVariant[] = [];
  for (const variant of variants) {
    try {
      await driver.applyConfig(ctx, target.name, variant.config);
      await driver.settle(ctx);
      const snap = await driver.snapshot(ctx, null);
      results.push({
        label: variant.label,
        field: variant.field,
        config: variant.config,
        screenshotPath: snap.screenshotPath,
      });
    } catch (err) {
      results.push({
        label: variant.label,
        field: variant.field,
        config: variant.config,
        screenshotPath: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { traitName: target.name, variants: results };
}
