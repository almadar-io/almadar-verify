import { describe, it, expect } from 'vitest';
import type { EdgeWalkTransition, SExpr } from '@almadar/core';
import { createFakeDriver } from '../impls/fake.js';
import type { TraitWalkConfig, WalkTransition } from '../../engine/types.js';

function transition(
  from: string,
  event: string,
  to: string,
  opts: { hasGuard?: boolean; effects?: WalkTransition['effects'] } = {},
): EdgeWalkTransition & Pick<WalkTransition, 'effects'> {
  return {
    from,
    event,
    to,
    hasGuard: opts.hasGuard ?? false,
    ...(opts.hasGuard ? { guard: ['>', '@payload.amount', 0] } : {}),
    ...(opts.effects ? { effects: opts.effects } : {}),
  };
}

const trait: TraitWalkConfig = {
  traitName: 'Modes',
  initialState: 'NORMAL',
  transitions: [
    transition('NORMAL', 'INIT', 'NORMAL'),
    transition('NORMAL', 'KEY', 'INSERT', {
      hasGuard: true,
      effects: [
        ['set', '@entity.count', 0],
        ['emit', 'SET_MODE', { mode: 'INSERT' }],
      ],
    }),
  ],
};

describe('createFakeDriver executeEffects hook', () => {
  it('reports empty effects/no extra emits when no hook is supplied — pre-existing behavior unchanged', () => {
    const { runtime } = createFakeDriver([trait], {
      evaluateGuard: () => true,
    });
    runtime.dispatch('Modes', 'KEY', { amount: 5 });
    expect(runtime.effectResults()).toEqual([]);
  });

  it('runs the declared effects through the hook and surfaces both effects and emits', () => {
    const { runtime } = createFakeDriver([trait], {
      evaluateGuard: () => true,
      executeEffects: (effects) => ({
        // `Effect`'s variadic tuple arms aren't structurally assignable to
        // `SExpr` under TS's tuple/index-signature check even though every
        // effect IS one at runtime — same established `as SExpr` boundary
        // `packages/almadar-tools/src/tools/lib/circuit-hooks.ts` documents.
        effects: effects.map((e) => ({
          type: Array.isArray(e) ? String(e[0]) : 'unknown',
          args: Array.isArray(e) ? (e.slice(1) as SExpr[]) : [],
          status: 'executed' as const,
        })),
        emitted: [{ event: 'SET_MODE', payload: { mode: 'INSERT' } }],
      }),
    });

    const result = runtime.dispatch('Modes', 'KEY', { editorId: 'e1' });
    expect(result.to).toBe('INSERT');
    expect(runtime.effectResults()).toEqual([
      { type: 'set', args: ['@entity.count', 0], status: 'executed' },
      { type: 'emit', args: ['SET_MODE', { mode: 'INSERT' }], status: 'executed' },
    ]);

    const drained = runtime.drain();
    // Input event echoed first, then the effect's own emit — matches the
    // real runtime bus (eventBus.onAny logs every emission in firing order).
    expect(drained.eventLogAdded.map((e) => e.type)).toEqual(['KEY', 'SET_MODE']);
    expect(drained.eventLogAdded[1].payload).toEqual({ mode: 'INSERT' });
  });

  it('never calls the effects hook when every arm guard fails — no state change, no effects', () => {
    let called = false;
    const { runtime } = createFakeDriver([trait], {
      evaluateGuard: () => false,
      executeEffects: () => {
        called = true;
        return { effects: [], emitted: [] };
      },
    });

    const result = runtime.dispatch('Modes', 'KEY', { amount: -5 });
    expect(result.to).toBeNull();
    expect(called).toBe(false);
    expect(runtime.effectResults()).toEqual([]);
  });

  it('leaves effectResults empty for a transition with no declared effects, even with a hook supplied', () => {
    let called = false;
    const { runtime } = createFakeDriver([trait], {
      evaluateGuard: () => true,
      executeEffects: () => {
        called = true;
        return { effects: [], emitted: [] };
      },
    });
    runtime.dispatch('Modes', 'INIT', {});
    expect(called).toBe(false);
    expect(runtime.effectResults()).toEqual([]);
  });
});
