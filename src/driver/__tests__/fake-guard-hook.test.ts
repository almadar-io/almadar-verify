import { describe, it, expect } from 'vitest';
import type { EdgeWalkTransition } from '@almadar/core';
import { createFakeDriver } from '../impls/fake.js';
import type { TraitWalkConfig } from '../../engine/types.js';

function transition(from: string, event: string, to: string, hasGuard = false): EdgeWalkTransition {
  return hasGuard ? { from, event, to, hasGuard: true, guard: ['>', '@payload.amount', 0] } : { from, event, to, hasGuard: false };
}

const trait: TraitWalkConfig = {
  traitName: 'Withdraw',
  initialState: 'idle',
  transitions: [
    transition('idle', 'INIT', 'idle'),
    transition('idle', 'SUBMIT', 'done', true),
  ],
};

describe('createFakeDriver guard-evaluator hook', () => {
  it('unconditional dispatch (no hook) still advances a guarded transition — pre-existing behavior unchanged', () => {
    const { runtime } = createFakeDriver([trait]);
    const result = runtime.dispatch('Withdraw', 'SUBMIT', { amount: -5 });
    expect(result.to).toBe('done');
  });

  it('blocks a guarded transition when the injected evaluator returns false', () => {
    const { runtime } = createFakeDriver([trait], {
      evaluateGuard: (_guard, ctx) => Number(ctx.payload['amount']) > 0,
    });

    const blocked = runtime.dispatch('Withdraw', 'SUBMIT', { amount: -5 });
    expect(blocked.to).toBeNull();
    expect(runtime.getState('Withdraw')).toBe('idle');

    const allowed = runtime.dispatch('Withdraw', 'SUBMIT', { amount: 5 });
    expect(allowed.to).toBe('done');
    expect(runtime.getState('Withdraw')).toBe('done');
  });

  it('never calls the evaluator for an unguarded transition', () => {
    let called = false;
    const { runtime } = createFakeDriver([trait], {
      evaluateGuard: () => {
        called = true;
        return false;
      },
    });
    const result = runtime.dispatch('Withdraw', 'INIT', {});
    expect(result.to).toBe('idle');
    expect(called).toBe(false);
  });
});
