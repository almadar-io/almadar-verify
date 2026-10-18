/**
 * walkTraitVerdict plays one trait's planned walk step by step, each step through the same engine
 * as the `play_transition` probe, grades every step with the kernel's `verifyJudge`, and stops at the first red
 * step. The Studio canvas plays the same walk one step at a time; the pre-deploy gate calls this
 * for the traits whose verdict is missing or stale.
 */
import { describe, it, expect } from 'vitest';
import type { CircuitStepResult, OrbitalSchema, SExpr } from '@almadar/core';
import type { Expectation } from '@almadar/core/kernel-wire';
import { observationOf, stepExpectation, stepVerdictOf, walkTraitVerdict as walkWith } from '../trait-walk.js';
import { testKernel } from '../../kernel/__tests__/test-kernel.js';

const walkTraitVerdict = (schema: OrbitalSchema, traitName: string, options?: Parameters<typeof walkWith>[3]): ReturnType<typeof walkWith> => walkWith(testKernel, schema, traitName, options);

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

  it('control: a guard no payload can pass is an inconclusive arm, never a pass', async () => {
    const walk = await walkTraitVerdict(orderApp(unsatisfiable), 'OrderFlow');
    expect(walk.status).toBe('inconclusive');
    expect(walk.detail).toMatch(/idle --PLACE--> placed: .*does not pass this arm's guard/);
    expect(walk.steps.filter((s) => !s.verdict.ok)).toHaveLength(0);
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

/**
 * `stepVerdict` retired into the kernel's `judge` (orbital-core `verify/plan_wire.rs`); its rules are pinned there by
 * `judge_ports_the_step_expectation_rules` and `judge_decides_each_outcome_from_the_expectation_alone`. These run the same
 * cases through the browser-side mapping (`observationOf` + `stepVerdictOf`) against the real kernel.
 */
const played = (o: Partial<CircuitStepResult> = {}): CircuitStepResult => ({
  trait: 'TaskList',
  event: 'SAVE',
  transitionFired: true,
  guard: 'none',
  state: { before: 'editing', after: 'saved' },
  effects: [],
  emitted: [],
  ...o,
});

const planned = (o: Partial<Expectation> = {}): Expectation => ({
  trait: 'TaskList',
  from: 'editing',
  event: 'SAVE',
  toStates: ['saved'],
  guarded: false,
  solved: true,
  payloadCase: 'success',
  acceptStates: [],
  ...o,
});

async function verdictOf(result: CircuitStepResult, expectation: Expectation = planned()) {
  const judged = await testKernel.judge(expectation, observationOf(result));
  return stepVerdictOf({ from: expectation.from, event: expectation.event, to: expectation.toStates[0], guardCase: expectation.guardCase }, result, judged);
}

describe('the kernel verdict on a played step', () => {
  it('passes a step that fired and reached the planned state', async () => {
    expect(await verdictOf(played())).toEqual({ ok: true });
  });

  it('fails a step whose guard failed, naming the transition', async () => {
    const v = await verdictOf(
      played({ transitionFired: false, guard: 'fail', state: { before: 'editing', after: 'editing' } }),
      planned({ guarded: true, arm: 0, guardCase: 'pass' }),
    );
    expect(v).toEqual({ ok: false, detail: 'The guard on editing --SAVE--> failed.' });
  });

  it('control: a planned guard-fail branch passes when the guard fails', async () => {
    const v = await verdictOf(
      played({ transitionFired: false, guard: 'fail', state: { before: 'editing', after: 'editing' } }),
      planned({ guarded: true, arm: 0, guardCase: 'fail', toStates: ['editing'] }),
    );
    expect(v).toEqual({ ok: true });
  });

  it('fails a step that reached another state', async () => {
    expect(await verdictOf(played({ state: { before: 'editing', after: 'error' } })))
      .toEqual({ ok: false, detail: 'editing --SAVE--> reached "error", expected "saved".' });
  });

  it('fails on a failed effect, but not on a write the access policy denied', async () => {
    const failed = played({ effects: [{ type: 'persist', args: [], status: 'failed', outcome: 'failed', error: 'no such entity' }] });
    expect(await verdictOf(failed)).toEqual({ ok: false, detail: 'editing --SAVE--> ran persist, which failed: no such entity' });
    const denied = played({ effects: [{ type: 'persist', args: [], status: 'failed', outcome: 'denied' }] });
    expect(await verdictOf(denied)).toEqual({ ok: true });
  });

  it('does not fail on an http effect whose failure the program routed, and fails on one it did not', async () => {
    const target = 'GET https://api.example.com/search';
    const routed = played({ effects: [{ type: 'http', args: [], status: 'failed', outcome: 'failed', error: 'verify has no network', target, routed: 'ERR' }] });
    expect(await verdictOf(routed)).toEqual({ ok: true });
    const unrouted = played({ effects: [{ type: 'http', args: [], status: 'failed', outcome: 'failed', error: 'verify has no network', target }] });
    expect(await verdictOf(unrouted)).toEqual({ ok: false, detail: 'editing --SAVE--> ran http, which failed: verify has no network' });
  });

  it('edge: a step that fired no transition, without a guard, fails', async () => {
    expect(await verdictOf(played({ transitionFired: false, state: { before: 'editing', after: 'editing' } })))
      .toEqual({ ok: false, detail: 'editing --SAVE--> did not fire.' });
  });
});
