/**
 * Reconcile-hop transient-closure tolerance (verifier-precision fix).
 *
 * `runVerification`'s hermetic preamble replays a trait from its initial
 * state to the next planned step's `from` via `planReplayTo`. Each hop is
 * dispatched through the same bus as a direct step, so it's exposed to the
 * exact same legitimate race a direct step already tolerates: a mocked
 * effect (fetch) resolving inside the driver's settle window, auto-
 * advancing the trait past the hop's naive `to` before the frame is read
 * (e.g. `empty --FETCH--> loading` settling at `cached`). Before this fix
 * the reconcile check was a bare `stateAfter !== to`, so that legitimate
 * race hard-failed as `replay-diverged`; a state genuinely outside the
 * effect-emitted closure must still fail.
 *
 * These fixtures mirror `std-cache-aside`'s empty→loading→{cached,error}
 * shape: `empty --FETCH--> loading` (fetch effect, emits `Loaded`/`Failed`),
 * `loading --Loaded--> cached`, `loading --Failed--> error`.
 */

import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';

function makeOrbital(): OrbitalSchema {
  return {
    name: 'std-cache-aside-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'CacheEntryOrbital',
        entity: {
          name: 'CacheEntry',
          persistence: 'runtime',
          fields: [{ name: 'id', type: 'string', required: true }],
        },
        pages: [
          { name: 'CacheEntryPage', path: '/cacheentrys', traits: [{ ref: 'CacheEntryCacheManager' }] },
        ],
        traits: [
          {
            name: 'CacheEntryCacheManager',
            scope: 'collection',
            linkedEntity: 'CacheEntry',
            stateMachine: {
              states: [
                { name: 'empty', isInitial: true },
                { name: 'loading' },
                { name: 'cached' },
                { name: 'error' },
              ],
              events: [
                { key: 'INIT', name: 'Initialize' },
                { key: 'FETCH', name: 'Fetch' },
                { key: 'Loaded', name: 'Loaded' },
                { key: 'Failed', name: 'Failed' },
              ],
              transitions: [
                { from: 'empty', to: 'empty', event: 'INIT' },
                {
                  from: 'empty',
                  to: 'loading',
                  event: 'FETCH',
                  effects: [['fetch', 'CacheEntry', { emit: { success: 'Loaded', failure: 'Failed' } }]],
                },
                { from: 'loading', to: 'cached', event: 'Loaded' },
                { from: 'loading', to: 'error', event: 'Failed' },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('runVerification — reconcile hop transient-closure tolerance', () => {
  it('accepts a reconcile hop that settles past its target inside the effect-emitted closure', async () => {
    const orbital = makeOrbital();
    const { driver, runtime } = createFakeDriver(
      (await import('../../planner/extract-trait-walk-configs.js')).extractTraitWalkConfigs(orbital),
    );

    // Wrap sendEvent so the FETCH dispatch simulates the settle-window
    // race: the mocked fetch resolves before the reconcile frame is read,
    // so the trait is observed at `cached` (past `loading`) rather than
    // exactly at `loading`.
    const originalSendEvent = driver.sendEvent.bind(driver);
    driver.sendEvent = async (ctx, event, payload, scope) => {
      const result = await originalSendEvent(ctx, event, payload, scope);
      if (event === 'FETCH') runtime.setState(ctx.trait.traitName, 'cached');
      return result;
    };

    const result = await runVerification({
      itemName: 'std-cache-aside-fixture',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: {
        enableInteractionTests: false,
        enableContractEvents: false,
        enableDataMutationTests: false,
        enableClickPathSamples: false,
        enablePortalPerStep: false,
        enableUserCrudFlow: false,
        enableTickTests: false,
        enableEmitSweep: false,
        log: () => {},
      },
    });

    expect(result.verdicts.replayDiverged).toBeUndefined();
    const reconcileFrames = result.frames.filter((f) => f.cause.triggerKind === 'reconcile');
    expect(reconcileFrames.length).toBeGreaterThan(0);
    expect(reconcileFrames.every((f) => f.accepted)).toBe(true);
  });

  it('still fails a reconcile hop that lands outside the effect-emitted closure', async () => {
    const orbital = makeOrbital();
    const { driver, runtime } = createFakeDriver(
      (await import('../../planner/extract-trait-walk-configs.js')).extractTraitWalkConfigs(orbital),
    );

    // Force the FETCH dispatch to land somewhere the trait's effect-emitted
    // closure never reaches (`loading`'s closure is {loading, cached,
    // error}) — a genuine divergence, must still fail.
    const originalSendEvent = driver.sendEvent.bind(driver);
    driver.sendEvent = async (ctx, event, payload, scope) => {
      const result = await originalSendEvent(ctx, event, payload, scope);
      if (event === 'FETCH') runtime.setState(ctx.trait.traitName, 'rogue-state');
      return result;
    };

    const result = await runVerification({
      itemName: 'std-cache-aside-fixture',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: {
        enableInteractionTests: false,
        enableContractEvents: false,
        enableDataMutationTests: false,
        enableClickPathSamples: false,
        enablePortalPerStep: false,
        enableUserCrudFlow: false,
        enableTickTests: false,
        enableEmitSweep: false,
        log: () => {},
      },
    });

    expect(result.verdicts.replayDiverged).toBeDefined();
    expect(result.verdicts.replayDiverged?.passed).toBe(false);
    expect(result.verdicts.replayDiverged?.detail).toContain('rogue-state');
  });
});
