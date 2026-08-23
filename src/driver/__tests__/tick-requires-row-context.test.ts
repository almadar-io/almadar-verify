import { describe, it, expect } from 'vitest';
import type { EdgeWalkTransition } from '@almadar/core';
import { tick } from '../tick.js';
import { createFakeDriver } from '../impls/fake.js';
import type { TraitWalkConfig } from '../../engine/types.js';
import type { ExtendedWalkStep } from '../../planner/types.js';

function transition(from: string, event: string, to: string): EdgeWalkTransition {
  return { from, event, to, hasGuard: false };
}

const trait: TraitWalkConfig = {
  traitName: 'ListItemDelete',
  initialState: 'idle',
  transitions: [
    transition('idle', 'INIT', 'idle'),
    transition('idle', 'DELETE', 'confirming'),
    transition('confirming', 'CONFIRM_DELETE', 'idle'),
  ],
};

function domStep(overrides: Partial<ExtendedWalkStep> = {}): ExtendedWalkStep {
  return {
    from: 'idle',
    event: 'UNREACHABLE_EVENT',
    to: 'confirming',
    guardCase: null,
    payload: {},
    isRepositioning: false,
    traitName: trait.traitName,
    triggerKind: 'dom',
    coverageKey: `${trait.traitName}:idle+UNREACHABLE_EVENT->confirming[crud-delete]`,
    testKind: 'crud-delete',
    ...overrides,
  };
}

describe('tick requiresRowContext skip (I-23)', () => {
  it('skips the bare bus fallback and marks the frame informational', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    const ctx = { outputDir: '/tmp', trait, runtime };
    const init = await tick(driver, ctx, null, {
      ...domStep({ event: 'INIT', to: 'idle', triggerKind: 'auto-init', testKind: undefined }),
    });

    const frame = await tick(driver, ctx, init, domStep({ requiresRowContext: true }));

    expect(frame.cause.bareDispatchSkipped).toMatch(/required payload field/);
    expect(frame.cause.triggerKind).toBe('dom');
    expect(frame.accepted).toBe(true);
    expect(frame.errors).toHaveLength(0);
  });

  it('without the flag, the same miss falls back to bus and fails closed', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    const ctx = { outputDir: '/tmp', trait, runtime };
    const init = await tick(driver, ctx, null, {
      ...domStep({ event: 'INIT', to: 'idle', triggerKind: 'auto-init', testKind: undefined }),
    });

    const frame = await tick(driver, ctx, init, domStep());

    expect(frame.cause.bareDispatchSkipped).toBeUndefined();
    expect(frame.cause.triggerKind).toBe('bus');
    expect(frame.accepted).toBe(false);
  });
});
