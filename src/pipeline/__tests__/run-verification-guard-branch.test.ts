/**
 * Reconcile-hop guard-branch tolerance.
 *
 * `planReplayTo`'s BFS assumes one target per `(from, event)`. When a state
 * declares SEVERAL guarded arms for the same event — `ui-debugger-board`'s
 * `playing --CHECK--> complete when <all bugs flagged>` alongside
 * `playing --CHECK--> playing when <not>` — the preamble plans one arm and
 * the runtime's guard truth may legitimately select the other. Landing on a
 * sibling arm's declared target is the state machine working; only a state
 * that NO transition declares for that `(from, event)` is real
 * nondeterminism.
 *
 * This surfaced when `ui-debugger-board`'s guard was repaired: the guard had
 * been reading a bare lambda parameter (`(object/get l isBug)`), which
 * evaluates to the string `"l"`, so the filter was always empty and the
 * `complete` arm always won. With the guard actually discriminating, the
 * replay started taking the `playing` arm and the preamble reported it as a
 * hard `replay-diverged` failure.
 *
 * Fixture shape mirrors that behavior: `menu --START--> playing`, then two
 * guarded `CHECK` arms out of `playing`.
 */

import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';

function makeOrbital(): OrbitalSchema {
  return {
    name: 'guard-branch-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'BoardOrbital',
        entity: {
          name: 'Board',
          persistence: 'runtime',
          fields: [{ name: 'id', type: 'string', required: true }],
        },
        pages: [{ name: 'BoardPage', path: '/boards', traits: [{ ref: 'BoardRender' }] }],
        traits: [
          {
            name: 'BoardRender',
            scope: 'collection',
            linkedEntity: 'Board',
            stateMachine: {
              states: [
                { name: 'menu', isInitial: true },
                { name: 'playing' },
                { name: 'complete' },
              ],
              events: [
                { key: 'INIT', name: 'Initialize' },
                { key: 'START', name: 'Start' },
                { key: 'CHECK', name: 'Check' },
                { key: 'PLAY_AGAIN', name: 'Play again' },
              ],
              transitions: [
                { from: 'menu', to: 'menu', event: 'INIT' },
                { from: 'menu', to: 'playing', event: 'START' },
                { from: 'playing', to: 'complete', event: 'CHECK', guard: ['==', '@entity.solved', true] },
                { from: 'playing', to: 'playing', event: 'CHECK', guard: ['!=', '@entity.solved', true] },
                { from: 'complete', to: 'menu', event: 'PLAY_AGAIN' },
              ],
            },
          },
        ],
      },
    ],
  };
}

const QUIET = {
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

describe('runVerification — reconcile hop guard-branch tolerance', () => {
  it('does not report divergence when the guard selects a sibling declared target', async () => {
    const orbital = makeOrbital();
    const { extractTraitWalkConfigs } = await import('../../planner/extract-trait-walk-configs.js');
    const { driver, runtime } = createFakeDriver(extractTraitWalkConfigs(orbital));

    // The replay plans `playing --CHECK--> complete` to establish the
    // `complete` precondition; the runtime's guard sends it back to
    // `playing` — the other declared arm of the same (from, event).
    const originalSendEvent = driver.sendEvent.bind(driver);
    driver.sendEvent = async (ctx, event, payload, scope) => {
      const result = await originalSendEvent(ctx, event, payload, scope);
      if (event === 'CHECK') runtime.setState(ctx.trait.traitName, 'playing');
      return result;
    };

    const result = await runVerification({
      itemName: 'guard-branch-fixture',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: { ...QUIET },
    });

    expect(result.verdicts.replayDiverged).toBeUndefined();
  });

  it('still reports divergence for a state no arm of that (from, event) declares', async () => {
    const orbital = makeOrbital();
    const { extractTraitWalkConfigs } = await import('../../planner/extract-trait-walk-configs.js');
    const { driver, runtime } = createFakeDriver(extractTraitWalkConfigs(orbital));

    const originalSendEvent = driver.sendEvent.bind(driver);
    driver.sendEvent = async (ctx, event, payload, scope) => {
      const result = await originalSendEvent(ctx, event, payload, scope);
      if (event === 'CHECK') runtime.setState(ctx.trait.traitName, 'rogue-state');
      return result;
    };

    const result = await runVerification({
      itemName: 'guard-branch-fixture',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: { ...QUIET },
    });

    expect(result.verdicts.replayDiverged).toBeDefined();
    expect(result.verdicts.replayDiverged?.passed).toBe(false);
    expect(result.verdicts.replayDiverged?.detail).toContain('rogue-state');
  });
});
