/**
 * I-24: `triggerDOM` returning `'no-row-affordance'` (default-dom-trigger.ts
 * — stages 1-3 all missed on a `crud-edit`/`crud-delete` step) must surface
 * as a real `crud-affordance-absent` frame finding, never a silent
 * `bareDispatchSkip`/bus-fallback downgrade. Ground truth: the VIEW-only
 * `itemActions` override shape (edit/delete removed from a row's config)
 * yields exactly this finding — never a `crud-edit` payload failure.
 *
 * @packageDocumentation
 */
import { describe, it, expect } from 'vitest';
import type { EdgeWalkTransition } from '@almadar/core';
import { tick } from '../tick.js';
import { createFakeDriver } from '../impls/fake.js';
import type { Driver } from '../types.js';
import type { FakeDriverContext } from '../impls/fake.js';
import type { TraitWalkConfig } from '../../engine/types.js';
import type { ExtendedWalkStep } from '../../planner/types.js';

function transition(from: string, event: string, to: string): EdgeWalkTransition {
  return { from, event, to, hasGuard: false };
}

const trait: TraitWalkConfig = {
  traitName: 'ListItemEdit',
  initialState: 'idle',
  transitions: [
    transition('idle', 'INIT', 'idle'),
    transition('idle', 'EDIT', 'editing'),
  ],
};

function domStep(overrides: Partial<ExtendedWalkStep> = {}): ExtendedWalkStep {
  return {
    from: 'idle',
    event: 'EDIT',
    to: 'editing',
    guardCase: null,
    payload: {},
    isRepositioning: false,
    traitName: trait.traitName,
    triggerKind: 'dom',
    coverageKey: `${trait.traitName}:idle+EDIT->editing[crud-edit]`,
    testKind: 'crud-edit',
    ...overrides,
  };
}

describe('tick — crud-affordance-absent (I-24)', () => {
  it('records a crud-affordance-absent finding, not a bus fallback, when triggerDOM finds no row affordance', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    // The VIEW-only itemActions shape: `triggerDOM` searched the DOM (row-
    // scoped click, unscoped fallback) and found no Edit control at all.
    const noAffordanceDriver: Driver<FakeDriverContext> = {
      ...driver,
      async triggerDOM() {
        return 'no-row-affordance' as const;
      },
    };
    const ctx = { outputDir: '/tmp', trait, runtime };
    const init = await tick(noAffordanceDriver, ctx, null, domStep({ event: 'INIT', to: 'idle', triggerKind: 'auto-init', testKind: undefined }));

    const frame = await tick(noAffordanceDriver, ctx, init, domStep());

    expect(frame.cause.crudAffordanceAbsent).toMatch(/no row exposes 'EDIT'/);
    expect(frame.cause.bareDispatchSkipped).toBeUndefined();
    expect(frame.cause.triggerKind).toBe('dom');
    expect(frame.accepted).toBe(false);
    expect(frame.errors).toHaveLength(1);
    expect(frame.errors[0]).toContain('no row exposes');
  });

  it('still falls back to bus when triggerDOM returns a plain false (non-crud dom step)', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    const bareFalseDriver: Driver<FakeDriverContext> = {
      ...driver,
      async triggerDOM() {
        return false;
      },
    };
    const ctx = { outputDir: '/tmp', trait, runtime };
    const init = await tick(bareFalseDriver, ctx, null, domStep({ event: 'INIT', to: 'idle', triggerKind: 'auto-init', testKind: undefined }));

    const frame = await tick(bareFalseDriver, ctx, init, domStep({ testKind: 'interaction' }));

    expect(frame.cause.crudAffordanceAbsent).toBeUndefined();
    expect(frame.cause.triggerKind).toBe('bus');
  });
});
