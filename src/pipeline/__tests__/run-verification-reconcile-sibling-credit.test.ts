/**
 * RECONCILE-SIBLING-CREDIT — a landing state matching some OTHER declared
 * arm's target is necessary but not SUFFICIENT to credit "guard selected a
 * declared sibling". Before this fix, `runVerification`'s reconcile-
 * divergence check credited any landing on an alternate declared `to`
 * unconditionally — so "no arm actually fired for the dispatched payload"
 * (every candidate guard rejects it) was indistinguishable from "the state
 * machine legitimately took the other branch". This is exactly the
 * disguise the `object/has` guard-payload gap wore: a synthesized payload
 * that couldn't satisfy ANY declared arm still landed on a state some
 * other arm happens to declare, and the check waved it through.
 *
 * Fixture: `playing --CHECK--> complete when @payload.key == 'submit'`
 * alongside `playing --CHECK--> playing when @payload.key == 'retry'`.
 * `PLAY_AGAIN` (from `complete`) forces a reconcile hop through the
 * `complete` arm, whose guard synthesizes `{key: 'submit'}`. The driver is
 * monkey-patched to force the runtime to `playing` regardless — the
 * `playing` arm's OWN guard (`key == 'retry'`) does not admit
 * `{key: 'submit'}`, so no arm actually fired: this must now report a
 * divergence, not a credited guard branch.
 */

import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, Transition } from '@almadar/core';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';

/**
 * `siblingGuard` parameterizes the `playing --CHECK--> playing` arm's guard
 * — the "sibling" the runtime is forced to land on. Building two full
 * schemas (rather than mutating one `OrbitalSchema`'s `traits[0]`, which is
 * `TraitRef = string | {ref,...} | Trait`) keeps each fixture concretely
 * typed without narrowing through that union.
 */
function makeOrbital(siblingGuard: Transition): OrbitalSchema {
  return {
    name: 'reconcile-sibling-credit-fixture',
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
                { from: 'playing', to: 'complete', event: 'CHECK', guard: ['==', '@payload.key', 'submit'] },
                siblingGuard,
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

describe('runVerification — reconcile-sibling-credit requires the sibling guard to actually admit the payload', () => {
  it('reports "no arm fired" divergence when the landed sibling\'s own guard rejects the dispatched payload', async () => {
    const orbital = makeOrbital({
      from: 'playing',
      to: 'playing',
      event: 'CHECK',
      guard: ['==', '@payload.key', 'retry'],
    });
    const { extractTraitWalkConfigs } = await import('../../planner/extract-trait-walk-configs.js');
    const { driver, runtime } = createFakeDriver(extractTraitWalkConfigs(orbital));

    // The replay plans `playing --CHECK--> complete` (dispatched with the
    // guard's synthesized pass payload `{key: 'submit'}`) to establish the
    // `complete` precondition for PLAY_AGAIN; force the runtime to land on
    // `playing` regardless — but `playing`'s OWN guard needs `key ===
    // 'retry'`, which `{key: 'submit'}` never satisfies. No arm actually
    // fired for this payload.
    const originalSendEvent = driver.sendEvent.bind(driver);
    driver.sendEvent = async (ctx, event, payload, scope) => {
      const result = await originalSendEvent(ctx, event, payload, scope);
      if (event === 'CHECK') runtime.setState(ctx.trait.traitName, 'playing');
      return result;
    };

    const result = await runVerification({
      itemName: 'reconcile-sibling-credit-fixture',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: { ...QUIET },
    });

    expect(result.verdicts.replayDiverged).toBeDefined();
    expect(result.verdicts.replayDiverged?.passed).toBe(false);
    expect(result.verdicts.replayDiverged?.detail).toContain('no arm fired for synthesized payload');
  });

  it('still credits the sibling branch when its OWN guard genuinely admits the dispatched payload', async () => {
    // Both arms accept the same key so whichever the runtime lands on is
    // legitimately satisfiable — this is the non-regression control.
    const orbital = makeOrbital({
      from: 'playing',
      to: 'playing',
      event: 'CHECK',
      guard: ['==', '@payload.key', 'submit'],
    });
    const { extractTraitWalkConfigs } = await import('../../planner/extract-trait-walk-configs.js');
    const { driver, runtime } = createFakeDriver(extractTraitWalkConfigs(orbital));

    const originalSendEvent = driver.sendEvent.bind(driver);
    driver.sendEvent = async (ctx, event, payload, scope) => {
      const result = await originalSendEvent(ctx, event, payload, scope);
      if (event === 'CHECK') runtime.setState(ctx.trait.traitName, 'playing');
      return result;
    };

    const result = await runVerification({
      itemName: 'reconcile-sibling-credit-fixture',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: { ...QUIET },
    });

    expect(result.verdicts.replayDiverged).toBeUndefined();
  });
});
