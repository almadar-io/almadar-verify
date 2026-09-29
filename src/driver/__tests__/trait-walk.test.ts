/**
 * walkTraitVerdict plays one trait's planned walk step by step, each step through the same engine
 * as the `play_transition` probe, grades every step with `stepVerdict`, and stops at the first red
 * step. The Studio canvas plays the same walk one step at a time; the pre-deploy gate calls this
 * for the traits whose verdict is missing or stale.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, SExpr } from '@almadar/core';
import { stepExpectation, walkTraitVerdict } from '../trait-walk.js';

function orderApp(guard: SExpr): OrbitalSchema {
  return {
    name: 'orders',
    orbitals: [{
      name: 'OrderOrbital',
      entity: { name: 'Order', persistence: 'persistent', fields: [{ name: 'qty', type: 'number', default: 0 }, { name: 'status', type: 'string', default: 'open' }] },
      pages: [],
      traits: [{
        name: 'OrderFlow',
        scope: 'instance',
        linkedEntity: 'Order',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }, { name: 'placed' }, { name: 'shipped' }],
          events: [{ key: 'PLACE', name: 'Place' }, { key: 'SHIP', name: 'Ship' }],
          transitions: [
            { from: 'idle', to: 'placed', event: 'PLACE', guard, effects: [['set', '@entity.status', 'placed']] },
            { from: 'placed', to: 'shipped', event: 'SHIP' },
          ],
        },
      }],
    }],
  };
}

const steerable: SExpr = ['>', '@payload.qty', 0];
const unsatisfiable: SExpr = ['and', ['>', '@payload.qty', 5], ['<', '@payload.qty', 3]];

describe('walkTraitVerdict', () => {
  it('passes a trait whose every planned step does what the plan expects, grading each step', async () => {
    const walk = await walkTraitVerdict(orderApp(steerable), 'OrderFlow');
    expect(walk.status).toBe('pass');
    expect(walk.steps.length).toBeGreaterThanOrEqual(2);
    expect(walk.steps.every((s) => s.verdict.ok)).toBe(true);
    expect(walk.steps.map((s) => `${s.from}-${s.event}`)).toContain('placed-SHIP');
  });

  it('control: a guard no payload can pass fails the walk at that step and stops there', async () => {
    const walk = await walkTraitVerdict(orderApp(unsatisfiable), 'OrderFlow');
    expect(walk.status).toBe('fail');
    expect(walk.detail).toMatch(/idle --PLACE-->/);
    const last = walk.steps[walk.steps.length - 1];
    expect(last.verdict.ok).toBe(false);
    expect(walk.steps.filter((s) => !s.verdict.ok)).toHaveLength(1);
  });

  it('the linked entity\'s first seeded row feeds the guard, as on the canvas', async () => {
    const byEntity: SExpr = ['>', '@entity.qty', 0];
    const seeded = (qty: number) => ({ Order: [{ id: 'o1', qty }, { id: 'o2', qty: 0 }] });
    expect((await walkTraitVerdict(orderApp(byEntity), 'OrderFlow', { mockData: seeded(3) })).steps[0].result.guard).toBe('pass');
    expect((await walkTraitVerdict(orderApp(byEntity), 'OrderFlow', { mockData: seeded(0) })).steps[0].result.guard).toBe('fail');
  });

  it('control: rows of an entity the trait does not link are never used', async () => {
    const byEntity: SExpr = ['>', '@entity.qty', 0];
    const walk = await walkTraitVerdict(orderApp(byEntity), 'OrderFlow', { mockData: { Other: [{ id: 'x', qty: 9 }] } });
    expect(walk.steps[0].result.guard).toBe('fail');
  });

  it('edge: an unknown trait is an error, not a pass', async () => {
    await expect(walkTraitVerdict(orderApp(steerable), 'Nope')).rejects.toThrow(/Nope/);
  });
});

describe('stepExpectation', () => {
  it('carries the planned step\'s arm, target, guard case and steerability', () => {
    expect(stepExpectation({ from: 'a', event: 'E', to: 'b', guardCase: 'fail', guardSteerable: false }))
      .toEqual({ from: 'a', event: 'E', to: 'b', guardCase: 'fail', guardSteerable: false });
  });

  it('control: an unknown steerability stays unset', () => {
    expect(stepExpectation({ from: 'a', event: 'E', to: 'b', guardCase: null })).toEqual({ from: 'a', event: 'E', to: 'b', guardCase: null });
  });
});

describe('stepExpectation from a planned step', () => {
  it('carries the planned arm\'s position and payload case', () => {
    expect(stepExpectation({ from: 'a', event: 'E', to: 'b', guardCase: 'pass', arm: 1, payloadCase: 'success' }))
      .toEqual({ from: 'a', event: 'E', to: 'b', guardCase: 'pass', arm: 1, payloadCase: 'success' });
  });
});
