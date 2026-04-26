/**
 * The std-browse end-to-end fixture.
 *
 * Runs `runVerification` against an in-memory FakeDriver using the
 * exact std-browse trait shape. Asserts 5/5 = 100% coverage — the
 * outcome the @almadar/core 5.9.0 INIT-filter fix unblocks. Pinning
 * this here means a regression in the kernel + planner + driver +
 * observer chain can never silently drop coverage back to the
 * pre-Phase-0 numbers.
 *
 * The blank-row VG11f fixture is also here: a fake SAVE that emits
 * an empty payload grows the count by +1 but content check fails,
 * matching the regression `probeEntityRowContent` was built to catch.
 */

import { describe, it, expect } from 'vitest';
import type { EdgeWalkTransition, EntityRow } from '@almadar/core';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';
import type { TraitWalkConfig } from '../../engine/types.js';
import type { EntityFieldLike } from '../../browser/catalog-probes.js';

function transition(from: string, event: string, to: string): EdgeWalkTransition {
  return { from, event, to, hasGuard: false };
}

const stdBrowseTrait: TraitWalkConfig = {
  traitName: 'BrowseItemBrowse',
  initialState: 'loading',
  transitions: [
    transition('loading', 'INIT', 'loading'),
    transition('loading', 'BrowseItemLoaded', 'browsing'),
    transition('loading', 'BrowseItemLoadFailed', 'error'),
    transition('browsing', 'INIT', 'loading'),
    transition('error', 'INIT', 'loading'),
  ],
};

describe('runVerification — std-browse end-to-end', () => {
  it('hits 5/5 = 100% coverage on the FakeDriver', async () => {
    const { driver, runtime } = createFakeDriver([stdBrowseTrait]);
    const ctx = { outputDir: '/tmp', runtime };

    const result = await runVerification({
      itemName: 'std-browse',
      traits: [stdBrowseTrait],
      driver,
      ctx,
      options: { log: () => {} },
    });

    expect(result.coverage.totalItems).toBe(5);
    expect(result.coverage.coveredItems).toBe(5);
    expect(result.coverage.ratio).toBe(1);
    expect(result.coverage.uncovered).toEqual([]);
  });

  it('every Frame in the std-browse stream is accepted', async () => {
    const { driver, runtime } = createFakeDriver([stdBrowseTrait]);
    const ctx = { outputDir: '/tmp', runtime };

    const result = await runVerification({
      itemName: 'std-browse',
      traits: [stdBrowseTrait],
      driver,
      ctx,
      options: { log: () => {} },
    });

    expect(result.frames).toHaveLength(5);
    expect(result.frames.every((f) => f.accepted)).toBe(true);
    // Frame 0 is the auto-init credit; the rest are walker steps.
    expect(result.frames[0].cause.triggerKind).toBe('auto-init');
    expect(result.frames.slice(1).every((f) => f.cause.triggerKind === 'bus')).toBe(true);
  });

  it('per-trait + per-trigger-kind breakdowns are correct', async () => {
    const { driver, runtime } = createFakeDriver([stdBrowseTrait]);
    const ctx = { outputDir: '/tmp', runtime };

    const result = await runVerification({
      itemName: 'std-browse',
      traits: [stdBrowseTrait],
      driver,
      ctx,
      options: { log: () => {} },
    });

    expect(result.coverage.perTrait.BrowseItemBrowse).toEqual({
      total: 5,
      covered: 5,
      uncoveredKeys: [],
    });
    expect(result.coverage.perTriggerKind['auto-init']).toEqual({ total: 1, covered: 1 });
    expect(result.coverage.perTriggerKind.bus).toEqual({ total: 4, covered: 4 });
    expect(result.coverage.perTriggerKind.dom).toEqual({ total: 0, covered: 0 });
  });

  it('produces a healthy refTrait verdict', async () => {
    const { driver, runtime } = createFakeDriver([stdBrowseTrait]);
    const ctx = { outputDir: '/tmp', runtime };

    const result = await runVerification({
      itemName: 'std-browse',
      traits: [stdBrowseTrait],
      driver,
      ctx,
      options: { log: () => {} },
    });

    expect(result.verdicts.refTrait?.passed).toBe(true);
  });
});

describe('runVerification — VG11f regression (blank-row catch)', () => {
  // The bug VG11f was built to catch: SAVE emits an empty payload, the
  // runtime grows the count by +1, but the new row has blank required
  // fields. Count-only check passes; assertMutation with requiredFields
  // must catch it.
  const cartTrait: TraitWalkConfig = {
    traitName: 'CartItemAddItem',
    initialState: 'idle',
    transitions: [transition('idle', 'SAVE', 'idle')],
  };

  const requiredFields: EntityFieldLike[] = [
    { name: 'name', type: 'string', required: true },
    { name: 'description', type: 'string', required: true },
  ];

  it('passes when every required field is populated', async () => {
    const { driver, runtime } = createFakeDriver([cartTrait]);
    const ctx = { outputDir: '/tmp', runtime };

    // Pre-stage: SAVE will be dispatched by the walker; for this fake,
    // we add the row before each tick by using runtime hook.
    runtime.seed('CartItem', []);

    // Patch the runtime to add a complete row when SAVE fires.
    const origDispatch = runtime.dispatch.bind(runtime);
    runtime.dispatch = ((traitName, event, payload) => {
      const result = origDispatch(traitName, event, payload);
      if (event === 'SAVE') {
        const before = runtime.entityData()['CartItem'] ?? [];
        runtime.seed('CartItem', [
          ...before,
          { id: `r${before.length + 1}`, name: 'Apple', description: 'red fruit' } as EntityRow,
        ]);
      }
      return result;
    }) as typeof runtime.dispatch;

    const result = await runVerification({
      itemName: 'cart-good',
      traits: [cartTrait],
      driver,
      ctx,
      rules: { mutation: [{ entityName: 'CartItem', expectedDelta: 1, requiredFields }] },
      options: { log: () => {} },
    });

    expect(result.verdicts.mutation?.passed).toBe(true);
  });

  it('FAILS when SAVE grows the count by +1 but the row has blank required fields', async () => {
    const { driver, runtime } = createFakeDriver([cartTrait]);
    const ctx = { outputDir: '/tmp', runtime };

    runtime.seed('CartItem', []);

    // Empty-payload SAVE: runtime adds a row with blank name/description.
    const origDispatch = runtime.dispatch.bind(runtime);
    runtime.dispatch = ((traitName, event, payload) => {
      const result = origDispatch(traitName, event, payload);
      if (event === 'SAVE') {
        const before = runtime.entityData()['CartItem'] ?? [];
        runtime.seed('CartItem', [
          ...before,
          { id: `r${before.length + 1}`, name: '', description: '' } as EntityRow,
        ]);
      }
      return result;
    }) as typeof runtime.dispatch;

    const result = await runVerification({
      itemName: 'cart-blank-row',
      traits: [cartTrait],
      driver,
      ctx,
      rules: { mutation: [{ entityName: 'CartItem', expectedDelta: 1, requiredFields }] },
      options: { log: () => {} },
    });

    expect(result.verdicts.mutation?.passed).toBe(false);
    expect(result.verdicts.mutation?.detail).toMatch(/content failed/);
  });
});
