import { describe, it, expect } from 'vitest';
import type { EntityRow, EvalTrace, RuntimeValue, SExpr } from '@almadar/core';
import { createMinimalContext, evaluate } from '@almadar/evaluator';
import { createCircuitHooks } from '../circuit-hooks.js';
import { playCircuitStep } from '../play-step.js';
import type { TraitWalkConfig } from '../../engine/types.js';

const GUARD: SExpr = ['=', '@payload.key', '@config.insertKey'];

const modes: TraitWalkConfig = {
  traitName: 'Modes',
  initialState: 'NORMAL',
  transitions: [
    {
      from: 'NORMAL',
      to: 'INSERT',
      event: 'KEY',
      hasGuard: true,
      guard: GUARD,
      effects: [
        ['set', '@entity.editorId', '@payload.editorId'],
        ['set', '@entity.count', ['+', '@entity.count', 1]],
        ['emit', 'SET_MODE', { editorId: '@entity.editorId', count: '@entity.count' }],
      ],
    },
    { from: 'NORMAL', to: 'NORMAL', event: 'KEY', hasGuard: false, effects: [['set', '@entity.count', -1]] },
    { from: 'NORMAL', to: 'NORMAL', event: 'TAP', hasGuard: false },
    { from: 'NORMAL', to: 'NORMAL', event: 'BREAK', hasGuard: false, effects: [['set', '@entity.count', ['array/nth', ['list']]], ['set', '@entity.editorId', 'after']] },
  ],
};

const row = (): EntityRow => ({ id: 'm', editorId: '', count: 0 });
const exitValue = (trace: EvalTrace | undefined, path: string): RuntimeValue | undefined =>
  trace?.find((s) => s.kind === 'exit' && s.path.join('.') === path)?.value;

describe('createCircuitHooks + playCircuitStep — a real, traced circuit step', () => {
  it('guard pass: fires, runs the effects in order against one row, and records each evaluation', async () => {
    const entity = row();
    const result = await playCircuitStep(modes, {
      from: 'NORMAL',
      event: 'KEY',
      payload: { editorId: 'e1', key: 'i' },
      ...createCircuitHooks(entity, 'NORMAL', { insertKey: 'i' }),
    });

    expect(result).toMatchObject({ guard: 'pass', transitionFired: true, state: { before: 'NORMAL', after: 'INSERT' } });
    expect(result.guards).toHaveLength(1);
    expect(result.firedArm).toBe(0);
    expect(result.guards?.[0]).toMatchObject({ arm: 0, guard: GUARD, passed: true });
    expect(exitValue(result.guards?.[0].trace, '1')).toBe('i');
    expect(exitValue(result.guards?.[0].trace, '')).toBe(true);

    expect(result.effects.map((e) => [e.type, e.status])).toEqual([['set', 'executed'], ['set', 'executed'], ['emit', 'executed']]);
    expect(exitValue(result.effects[1].evalTrace, '2')).toBe(1);
    expect(entity).toMatchObject({ editorId: 'e1', count: 1 });
    expect(result.emitted.map((e) => e.type)).toEqual(['KEY', 'SET_MODE']);
    expect(result.emitted[1].payload).toEqual({ editorId: 'e1', count: 1 });
  });

  it('guard fail with an unguarded fallback: the fallback fires and the failed guard is still recorded', async () => {
    const entity = row();
    const result = await playCircuitStep(modes, {
      from: 'NORMAL',
      event: 'KEY',
      payload: { editorId: 'e1', key: 'x' },
      ...createCircuitHooks(entity, 'NORMAL', { insertKey: 'i' }),
    });

    expect(result).toMatchObject({ guard: 'none', transitionFired: true, state: { after: 'NORMAL' } });
    expect(result.firedArm).toBe(1);
    expect(result.guards?.map((g) => [g.arm, g.passed])).toEqual([[0, false]]);
    expect(exitValue(result.guards?.[0].trace, '')).toBe(false);
    expect(entity['count']).toBe(-1);
  });

  it('control: when every guard fails no arm is named and nothing fires', async () => {
    const guardedOnly: TraitWalkConfig = { ...modes, transitions: [modes.transitions[0]] };
    const result = await playCircuitStep(guardedOnly, {
      from: 'NORMAL',
      event: 'KEY',
      payload: { key: 'x' },
      ...createCircuitHooks(row(), 'NORMAL', { insertKey: 'i' }),
    });
    expect(result.guard).toBe('fail');
    expect(result.firedArm).toBeUndefined();
    expect(result.guards?.map((g) => g.passed)).toEqual([false]);
  });

  it('control: an unguarded transition records no guards and no effects', async () => {
    const result = await playCircuitStep(modes, { from: 'NORMAL', event: 'TAP', ...createCircuitHooks(row(), 'NORMAL') });
    expect(result.guard).toBe('none');
    expect(result.guards).toBeUndefined();
    expect(result.effects).toEqual([]);
  });

  it('control: a boolean guard hook still works and records nothing', async () => {
    const result = await playCircuitStep(modes, {
      from: 'NORMAL',
      event: 'KEY',
      payload: { key: 'i' },
      evaluateGuard: () => true,
    });
    expect(result.guard).toBe('pass');
    expect(result.guards).toBeUndefined();
  });

  it('a failing effect reports its error and partial trace; the next effect still runs', async () => {
    const entity = row();
    const result = await playCircuitStep(modes, { from: 'NORMAL', event: 'BREAK', ...createCircuitHooks(entity, 'NORMAL') });
    expect(result.effects[0].status).toBe('failed');
    expect(result.effects[0].error).toBeDefined();
    expect(result.effects[0].evalTrace?.some((s) => s.kind === 'exit' && s.error !== undefined)).toBe(true);
    expect(result.effects[1].status).toBe('executed');
    expect(entity['editorId']).toBe('after');
  });

  it('a guard that errors fails with its error recorded', () => {
    const hooks = createCircuitHooks(row(), 'NORMAL');
    const verdict = hooks.evaluateGuard(['>', ['array/nth', ['list']], 0], { traitName: 'Modes', event: 'KEY', payload: {} });
    expect(verdict.passed).toBe(false);
    expect(verdict.error).toBeDefined();
  });

  it('parity: the traced guard verdict equals the plain evaluator on the same bindings', () => {
    const hooks = createCircuitHooks(row(), 'NORMAL', { insertKey: 'i' });
    for (const key of ['i', 'x']) {
      const ctx = createMinimalContext(row(), { key }, 'NORMAL');
      ctx.config = { insertKey: 'i' };
      expect(hooks.evaluateGuard(GUARD, { traitName: 'Modes', event: 'KEY', payload: { key } }).passed).toBe(Boolean(evaluate(GUARD, ctx)));
    }
  });
});
