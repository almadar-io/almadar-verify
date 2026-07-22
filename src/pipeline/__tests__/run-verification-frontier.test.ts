/**
 * Frontier walk scope (`options.walkScope: 'frontier'`).
 *
 * Fixture: one trait authored on the orbital + one trait cloned from a
 * `uses[]` import (carries the resolve/inline `sourceBehavior` stamp).
 * Frontier walks the authored topology in full, skips the imported
 * topology (verified in the source atom's own corpus), scopes the
 * schema coverage denominator to the walked traits, and reports the
 * skip explicitly in `report.frontier`. The default `'full'` scope is
 * byte-identical to pre-frontier behavior: no `frontier` block, both
 * topologies walked.
 */

import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';
import { extractTraitWalkConfigs } from '../../planner/extract-trait-walk-configs.js';

const mixed: OrbitalSchema = {
  name: 'frontier-fixture',
  designTokens: {},
  customPatterns: {},
  orbitals: [
    {
      name: 'ItemOrbital',
      entity: {
        name: 'Item',
        persistence: 'runtime',
        fields: [{ name: 'id', type: 'string', required: true }],
      },
      pages: [
        { name: 'ItemPage', path: '/items', traits: [{ ref: 'ItemComposer' }, { ref: 'ItemButton' }] },
      ],
      traits: [
        {
          name: 'ItemComposer',
          scope: 'collection',
          linkedEntity: 'Item',
          stateMachine: {
            states: [
              { name: 'loading', isInitial: true },
              { name: 'composing' },
            ],
            events: [
              { key: 'INIT', name: 'Initialize' },
              { key: 'ItemLoaded', name: 'Loaded' },
            ],
            transitions: [
              { from: 'loading', to: 'loading', event: 'INIT' },
              { from: 'loading', to: 'composing', event: 'ItemLoaded' },
            ],
          },
        },
        {
          name: 'ItemButton',
          scope: 'collection',
          linkedEntity: 'Item',
          sourceBehavior: {
            behavior: 'std/behaviors/ui-button',
            alias: 'Button',
            originalName: 'ButtonRender',
          },
          stateMachine: {
            states: [
              { name: 'ready', isInitial: true },
              { name: 'pressed' },
            ],
            events: [
              { key: 'INIT', name: 'Initialize' },
              { key: 'PRESS', name: 'Press' },
              { key: 'RELEASE', name: 'Release' },
            ],
            transitions: [
              { from: 'ready', to: 'ready', event: 'INIT' },
              { from: 'ready', to: 'pressed', event: 'PRESS' },
              { from: 'pressed', to: 'ready', event: 'RELEASE' },
            ],
          },
        },
      ],
    },
  ],
};

const quietOptions = {
  enableInteractionTests: false,
  enableContractEvents: false,
  enableDataMutationTests: false,
  enableClickPathSamples: false,
  enablePortalPerStep: false,
  enableUserCrudFlow: false,
  enableTickTests: false,
  enableEmitSweep: false,
  log: () => {},
} as const;

describe('runVerification — frontier walk scope', () => {
  it('frontier walks authored topology only and reports the skip', async () => {
    const traits = extractTraitWalkConfigs(mixed);
    const { driver, runtime } = createFakeDriver(traits);
    const ctx = { outputDir: '', runtime };

    const result = await runVerification({
      itemName: 'frontier-fixture',
      orbital: mixed,
      driver,
      ctx,
      options: { ...quietOptions, walkScope: 'frontier' },
    });

    expect(result.frontier).toBeDefined();
    expect(result.frontier?.authoredTraits).toBe(1);
    expect(result.frontier?.importedTraits).toBe(1);
    expect(result.frontier?.importedTransitionsSkipped).toBe(3);
    expect(result.frontier?.skipped).toEqual([
      { trait: 'ItemButton', source: 'std/behaviors/ui-button', transitions: 3 },
    ]);

    // Denominator = authored transitions only (2), all covered.
    expect(result.coverage.schemaTransitions).toBe(2);
    expect(result.coverage.totalItems).toBe(2);
    expect(result.coverage.coveredItems).toBe(2);

    // No frames dispatched against the imported trait.
    expect(result.frames.some((f) => f.cause.traitName === 'ItemButton')).toBe(false);
  });

  it("default 'full' scope is unchanged: both topologies walked, no frontier block", async () => {
    const traits = extractTraitWalkConfigs(mixed);
    const { driver, runtime } = createFakeDriver(traits);
    const ctx = { outputDir: '', runtime };

    const result = await runVerification({
      itemName: 'frontier-fixture',
      orbital: mixed,
      driver,
      ctx,
      options: { ...quietOptions },
    });

    expect(result.frontier).toBeUndefined();
    expect(result.coverage.schemaTransitions).toBe(5);
    expect(result.frames.some((f) => f.cause.traitName === 'ItemButton')).toBe(true);
  });
});
