/**
 * One verdict for a played circuit step against its planned expectation, shared by the Studio
 * canvas (verify a transition or a trait's walk) and the pre-deploy gate.
 */
import { describe, it, expect } from 'vitest';
import type { CircuitStepResult } from '@almadar/core';
import { stepVerdict } from '../step-verdict.js';

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

describe('stepVerdict', () => {
  it('passes a step that fired and reached the planned state', () => {
    expect(stepVerdict(played(), { from: 'editing', event: 'SAVE', to: 'saved', guardCase: null })).toEqual({ ok: true });
  });

  it('fails a step whose guard failed, naming the transition', () => {
    const v = stepVerdict(played({ transitionFired: false, guard: 'fail', state: { before: 'editing', after: 'editing' } }), { from: 'editing', event: 'SAVE', to: 'saved', guardCase: 'pass' });
    expect(v).toEqual({ ok: false, detail: 'The guard on editing --SAVE--> failed.' });
  });

  it('control: a planned guard-fail branch passes when the guard fails', () => {
    expect(stepVerdict(played({ transitionFired: false, guard: 'fail', state: { before: 'editing', after: 'editing' } }), { from: 'editing', event: 'SAVE', to: 'editing', guardCase: 'fail' })).toEqual({ ok: true });
  });

  it('fails a step that reached another state', () => {
    expect(stepVerdict(played({ state: { before: 'editing', after: 'error' } }), { from: 'editing', event: 'SAVE', to: 'saved', guardCase: null }))
      .toEqual({ ok: false, detail: 'editing --SAVE--> reached "error", expected "saved".' });
  });

  it('fails on a failed effect, but not on a write the access policy denied', () => {
    const failed = played({ effects: [{ type: 'persist', args: [], status: 'failed', outcome: 'failed', error: 'no such entity' }] });
    expect(stepVerdict(failed, { from: 'editing', event: 'SAVE', to: 'saved', guardCase: null })).toEqual({ ok: false, detail: 'editing --SAVE--> ran persist, which failed: no such entity' });
    const denied = played({ effects: [{ type: 'persist', args: [], status: 'failed', outcome: 'denied' }] });
    expect(stepVerdict(denied, { from: 'editing', event: 'SAVE', to: 'saved', guardCase: null })).toEqual({ ok: true });
  });

  it('edge: a step that fired no transition, without a guard, fails', () => {
    expect(stepVerdict(played({ transitionFired: false, state: { before: 'editing', after: 'editing' } }), { from: 'editing', event: 'SAVE', to: 'saved', guardCase: null }))
      .toEqual({ ok: false, detail: 'editing --SAVE--> did not fire.' });
  });
});

describe('stepVerdict on a guard the payload cannot steer', () => {
  it('is inconclusive, not red, when the planned branch is not the one taken', () => {
    const passed = played({ guard: 'pass' });
    expect(stepVerdict(passed, { from: 'editing', event: 'SAVE', to: 'editing', guardCase: 'fail', guardSteerable: false }))
      .toEqual({ ok: true, inconclusive: true, detail: 'The guard on editing --SAVE--> does not depend on the event payload, so its fail branch cannot be driven from here.' });
  });

  it('control: a steerable guard taking the wrong branch is still red', () => {
    const passed = played({ guard: 'pass' });
    expect(stepVerdict(passed, { from: 'editing', event: 'SAVE', to: 'editing', guardCase: 'fail', guardSteerable: true }).ok).toBe(false);
  });
});

describe('stepVerdict judges the planned arm among a (from, event) pair\'s arms', () => {
  it('a fail variant passes when a sibling arm fired instead: the planned arm was rejected', () => {
    const sibling = played({ guard: 'pass', firedArm: 1, state: { before: 'loading', after: 'loading' } });
    expect(stepVerdict(sibling, { from: 'loading', event: 'INIT', to: 'loading', guardCase: 'fail', arm: 0 })).toEqual({ ok: true });
  });

  it('control: a fail variant whose own arm fired is red', () => {
    const own = played({ guard: 'pass', firedArm: 0, state: { before: 'loading', after: 'loading' } });
    expect(stepVerdict(own, { from: 'loading', event: 'INIT', to: 'loading', guardCase: 'fail', arm: 0 }).ok).toBe(false);
  });

  it('a pass variant where a sibling arm fired instead is red, naming it', () => {
    const sibling = played({ guard: 'none', firedArm: 1, state: { before: 'adding', after: 'creating' } });
    expect(stepVerdict(sibling, { from: 'adding', event: 'ADD', to: 'ready', guardCase: 'pass', arm: 0, guardSteerable: true }))
      .toEqual({ ok: false, detail: 'The guard on adding --ADD--> failed, so another arm (to "creating") fired.' });
  });

  it('edge: the same, on a guard the payload cannot steer, is inconclusive', () => {
    const sibling = played({ guard: 'none', firedArm: 1, state: { before: 'adding', after: 'creating' } });
    const v = stepVerdict(sibling, { from: 'adding', event: 'ADD', to: 'ready', guardCase: 'pass', arm: 0, guardSteerable: false });
    expect(v.ok).toBe(true);
    expect(v.inconclusive).toBe(true);
  });
});

describe('stepVerdict on a malformed (empty-payload) step', () => {
  it('is inconclusive: the payload validator that rejects it is not part of a circuit step', () => {
    const v = stepVerdict(played({ transitionFired: false, guard: 'fail', state: { before: 'idle', after: 'idle' } }), { from: 'idle', event: 'DELETE', to: 'confirming', guardCase: null, payloadCase: 'malformed' });
    expect(v).toMatchObject({ ok: true, inconclusive: true });
  });

  it('control: the success variant of the same arm is still graded', () => {
    const v = stepVerdict(played({ transitionFired: false, guard: 'fail', state: { before: 'idle', after: 'idle' } }), { from: 'idle', event: 'DELETE', to: 'confirming', guardCase: 'pass', payloadCase: 'success' });
    expect(v.ok).toBe(false);
  });
});
