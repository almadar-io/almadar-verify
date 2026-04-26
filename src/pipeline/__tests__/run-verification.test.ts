/**
 * The std-browse end-to-end fixture.
 *
 * Runs `runVerification` against an in-memory FakeDriver using a
 * core-typed `OrbitalSchema` that mirrors std-browse. Asserts 5/5 =
 * 100% coverage — the outcome the @almadar/core 5.9.0 INIT-filter fix
 * unblocks. Pinning this here means a regression in any layer (planner,
 * driver, kernel, observer) drops coverage back below 100% at unit
 * test time, before the gate.
 */

import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';
import { extractTraitWalkConfigs } from '../../planner/extract-trait-walk-configs.js';

const stdBrowse: OrbitalSchema = {
  name: 'std-browse',
  designTokens: {},
  customPatterns: {},
  orbitals: [
    {
      name: 'BrowseItemOrbital',
      entity: {
        name: 'BrowseItem',
        persistence: 'runtime',
        fields: [{ name: 'id', type: 'string', required: true }],
      },
      pages: [
        { name: 'BrowseItemPage', path: '/browseitems', traits: [{ ref: 'BrowseItemBrowse' }] },
      ],
      traits: [
        {
          name: 'BrowseItemBrowse',
          scope: 'collection',
          linkedEntity: 'BrowseItem',
          stateMachine: {
            states: [
              { name: 'loading', isInitial: true },
              { name: 'browsing' },
              { name: 'error' },
            ],
            events: [
              { key: 'INIT', name: 'Initialize' },
              { key: 'BrowseItemLoaded', name: 'Loaded' },
              { key: 'BrowseItemLoadFailed', name: 'Load failed' },
            ],
            transitions: [
              { from: 'loading', to: 'loading', event: 'INIT' },
              { from: 'loading', to: 'browsing', event: 'BrowseItemLoaded' },
              { from: 'loading', to: 'error', event: 'BrowseItemLoadFailed' },
              { from: 'browsing', to: 'loading', event: 'INIT' },
              { from: 'error', to: 'loading', event: 'INIT' },
            ],
          },
        },
      ],
    },
  ],
};

describe('runVerification — std-browse end-to-end', () => {
  it('hits 5/5 = 100% coverage on the FakeDriver', async () => {
    const traits = extractTraitWalkConfigs(stdBrowse);
    const { driver, runtime } = createFakeDriver(traits);
    const ctx = { outputDir: '/tmp', runtime };

    const result = await runVerification({
      itemName: 'std-browse',
      orbital: stdBrowse,
      driver,
      ctx,
      options: {
        // No render-ui in this fixture → no interaction/click-path verdicts.
        enableInteractionTests: false,
        enableContractEvents: false,
        enableDataMutationTests: false,
        enableClickPathSamples: false,
        enablePortalPerStep: false,
        log: () => {},
      },
    });

    expect(result.coverage.totalItems).toBe(5);
    expect(result.coverage.coveredItems).toBe(5);
    expect(result.coverage.ratio).toBe(1);
    expect(result.coverage.uncovered).toEqual([]);
  });

  it('every Frame in the std-browse stream is accepted', async () => {
    const traits = extractTraitWalkConfigs(stdBrowse);
    const { driver, runtime } = createFakeDriver(traits);
    const ctx = { outputDir: '/tmp', runtime };

    const result = await runVerification({
      itemName: 'std-browse',
      orbital: stdBrowse,
      driver,
      ctx,
      options: {
        enableInteractionTests: false,
        enableContractEvents: false,
        enableDataMutationTests: false,
        enableClickPathSamples: false,
        enablePortalPerStep: false,
        log: () => {},
      },
    });

    expect(result.frames).toHaveLength(5);
    expect(result.frames.every((f) => f.accepted)).toBe(true);
    expect(result.frames[0].cause.triggerKind).toBe('auto-init');
    expect(result.frames.slice(1).every((f) => f.cause.triggerKind === 'bus')).toBe(true);
  });

  it('produces a healthy refTrait verdict', async () => {
    const traits = extractTraitWalkConfigs(stdBrowse);
    const { driver, runtime } = createFakeDriver(traits);
    const ctx = { outputDir: '/tmp', runtime };

    const result = await runVerification({
      itemName: 'std-browse',
      orbital: stdBrowse,
      driver,
      ctx,
      options: {
        enableInteractionTests: false,
        enableContractEvents: false,
        enableDataMutationTests: false,
        enableClickPathSamples: false,
        enablePortalPerStep: false,
        log: () => {},
      },
    });

    expect(result.verdicts.refTrait?.passed).toBe(true);
  });
});
