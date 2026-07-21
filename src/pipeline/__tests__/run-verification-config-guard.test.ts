/**
 * GAP 2 regression — config-bound guard variants must not trip
 * `assertGuardParity`.
 *
 * Mirrors std-data-erasure / std-mod-queue's real `.orb` shape exactly:
 * `OPEN -> loading when @config.enabled` (a bare-string-atom guard, not
 * an `["=", ...]` call), with `enabled` defaulting `false`. The payload
 * can't steer a config-bound guard, so both the `pass` and `fail`
 * variants the planner synthesizes are stamped `guardSteerable: false`
 * end-to-end and `assertGuardParity` must skip them — not report
 * "OPEN guard 'fail' dispatch behaved unexpectedly".
 */

import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';
import { extractTraitWalkConfigs } from '../../planner/extract-trait-walk-configs.js';

const erasureLikeOrbital: OrbitalSchema = {
  name: 'std-data-erasure',
  designTokens: {},
  customPatterns: {},
  orbitals: [
    {
      name: 'ErasureOrbital',
      entity: {
        name: 'ErasureRequest',
        persistence: 'runtime',
        fields: [{ name: 'id', type: 'string', required: true }],
      },
      pages: [
        { name: 'ErasureRequestPage', path: '/erasurerequests', traits: [{ ref: 'Erasure' }] },
      ],
      traits: [
        {
          name: 'Erasure',
          scope: 'collection',
          linkedEntity: 'ErasureRequest',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }, { name: 'loading' }],
            events: [{ key: 'INIT', name: 'Init' }, { key: 'OPEN', name: 'Open' }],
            transitions: [
              { from: 'idle', to: 'idle', event: 'INIT' },
              { from: 'idle', to: 'loading', event: 'OPEN', guard: '@config.enabled' },
            ],
          },
        },
      ],
    },
  ],
};

describe('runVerification — config-bound guard (std-data-erasure/std-mod-queue OPEN shape)', () => {
  it('does not flag guardParity for the unsteerable @config.enabled guard-fail variant', async () => {
    const traits = extractTraitWalkConfigs(erasureLikeOrbital);
    const { driver, runtime } = createFakeDriver(traits);

    const result = await runVerification({
      itemName: 'std-data-erasure',
      orbital: erasureLikeOrbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: {
        enableInteractionTests: false,
        enableContractEvents: false,
        enableDataMutationTests: false,
        enableClickPathSamples: false,
        enableUserCrudFlow: false,
        enableTickTests: false,
        enableEmitSweep: false,
        enablePortalPerStep: false,
        log: () => {},
      },
    });

    const openFrames = result.frames.filter((f) => f.cause.event === 'OPEN');
    expect(openFrames.length).toBeGreaterThan(0);
    expect(openFrames.every((f) => f.cause.guardSteerable === false)).toBe(true);
    expect(result.verdicts.guardParity?.passed).toBe(true);
    expect(result.verdicts.guardParity?.detail).not.toContain('behaved unexpectedly');
  });

  it('does not flag guardParity when `orbital resolve` const-folds the guard to a literal (real std-mod-queue/std-data-erasure frame-3 shape)', async () => {
    // `orbital resolve` on the actual .lolo (verified directly) const-folds
    // `@config.enabled` (default false, no override in standalone verify)
    // all the way to the literal `guard: false` — not a string/array
    // `@config.*` reference. Only the guard-fail variant is emitted
    // (constant false => canPass is false), matching the real frame log
    // (one 'fail' frame, no 'pass' counterpart).
    const constFoldedOrbital: OrbitalSchema = {
      name: 'std-mod-queue',
      designTokens: {},
      customPatterns: {},
      orbitals: [
        {
          name: 'ModQueueItemOrbital',
          entity: {
            name: 'ModQueueItem',
            persistence: 'runtime',
            fields: [{ name: 'id', type: 'string', required: true }],
          },
          pages: [
            { name: 'ModQueueItemPage', path: '/modqueueitems', traits: [{ ref: 'ModQueueItemReview' }] },
          ],
          traits: [
            {
              name: 'ModQueueItemReview',
              scope: 'collection',
              linkedEntity: 'ModQueueItem',
              stateMachine: {
                states: [{ name: 'idle', isInitial: true }, { name: 'loading' }],
                events: [{ key: 'INIT', name: 'Init' }, { key: 'OPEN', name: 'Open' }],
                transitions: [
                  { from: 'idle', to: 'idle', event: 'INIT' },
                  { from: 'idle', to: 'loading', event: 'OPEN', guard: false },
                ],
              },
            },
          ],
        },
      ],
    };

    const traits = extractTraitWalkConfigs(constFoldedOrbital);
    const { driver, runtime } = createFakeDriver(traits);
    // FakeDriver's dispatch matches `(from, event)` unconditionally — it
    // doesn't evaluate guards, so it transitions on the guard-fail
    // dispatch exactly the way the real divergence report described
    // (state moved when the 'fail' prediction expected it to hold).
    // This is the precise shape the checker must still skip.

    const result = await runVerification({
      itemName: 'std-mod-queue',
      orbital: constFoldedOrbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: {
        enableInteractionTests: false,
        enableContractEvents: false,
        enableDataMutationTests: false,
        enableClickPathSamples: false,
        enableUserCrudFlow: false,
        enableTickTests: false,
        enableEmitSweep: false,
        enablePortalPerStep: false,
        log: () => {},
      },
    });

    const openFrames = result.frames.filter((f) => f.cause.event === 'OPEN');
    expect(openFrames.length).toBeGreaterThan(0);
    expect(openFrames.every((f) => f.cause.guardCase === 'fail')).toBe(true);
    expect(openFrames.every((f) => f.cause.guardSteerable === false)).toBe(true);
    // FakeDriver transitioned anyway (guard-blind) — a real divergence if
    // this were steerable. Confirm it actually diverged locally so the
    // skip is proven, not vacuous.
    expect(openFrames.some((f) => !f.accepted)).toBe(true);
    expect(result.verdicts.guardParity?.passed).toBe(true);
    expect(result.verdicts.guardParity?.detail).not.toContain('behaved unexpectedly');
  });
});
