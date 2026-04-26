import { describe, it, expect } from 'vitest';
import type { ReplayStep } from '@almadar/core';
import { planInteractionTests, type InteractionTestSpec } from '../plan-interaction-tests.js';
import type { TraitWalkConfig } from '../../engine/types.js';

const trait: TraitWalkConfig = {
  traitName: 'CartItemAddItem',
  initialState: 'browsing',
  transitions: [],
};

const baseTest: InteractionTestSpec = {
  trait: 'CartItemAddItem',
  event: 'ADD_ITEM',
  fromState: 'browsing',
  toState: 'form',
  slot: 'modal',
  targetPattern: 'modal',
  patternCategory: 'component',
  linkedEntity: 'CartItem',
  needsEntityData: false,
  payloadSchema: [],
  replayPath: [],
  guardBranch: 'unguarded',
};

describe('planInteractionTests', () => {
  it('emits one dom step per test, tagged interaction, with expectedPattern', () => {
    const steps = planInteractionTests({ traits: [trait], tests: [baseTest] });
    expect(steps).toHaveLength(1);
    expect(steps[0].triggerKind).toBe('dom');
    expect(steps[0].testKind).toBe('interaction');
    expect(steps[0].event).toBe('ADD_ITEM');
    expect(steps[0].expectedPattern).toBe('modal');
    expect(steps[0].coverageKey).toMatch(/\[interaction\]$/);
  });

  it('includes formData when target pattern is a form', () => {
    const formTest: InteractionTestSpec = {
      ...baseTest,
      event: 'SAVE',
      toState: 'idle',
      targetPattern: 'form-section',
      patternCategory: 'form',
      payloadSchema: [
        { name: 'name', type: 'string', required: true },
        { name: 'description', type: 'string', required: true },
      ],
    };
    const steps = planInteractionTests({
      traits: [trait],
      tests: [formTest],
      entityFields: { CartItem: [{ name: 'name', type: 'string' }, { name: 'description', type: 'string' }] },
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].formData).toBeDefined();
    expect(steps[0].formData?.name).toBeDefined();
    expect(steps[0].formData?.description).toBeDefined();
  });

  it('omits formData for non-form patterns', () => {
    const steps = planInteractionTests({ traits: [trait], tests: [baseTest] });
    expect(steps[0].formData).toBeUndefined();
  });

  it('expands replay path inline as triggerKind: replay steps', () => {
    const replayPath: ReplayStep[] = [
      { event: 'OPEN', fromState: 'browsing', toState: 'form', slot: 'modal', needsEntityData: false },
    ];
    const test: InteractionTestSpec = {
      ...baseTest,
      event: 'SAVE',
      fromState: 'form',
      replayPath,
    };
    const steps = planInteractionTests({ traits: [trait], tests: [test] });
    expect(steps).toHaveLength(2);
    expect(steps[0].triggerKind).toBe('replay');
    expect(steps[0].event).toBe('OPEN');
    expect(steps[1].triggerKind).toBe('dom');
  });

  it('emits guarded steps with guardCase set + guardPayload as payload', () => {
    const guardedPass: InteractionTestSpec = {
      ...baseTest,
      event: 'SAVE',
      guardBranch: 'pass',
      guardPayload: { qty: 5 },
    };
    const guardedFail: InteractionTestSpec = {
      ...baseTest,
      event: 'SAVE',
      guardBranch: 'fail',
      guardPayload: { qty: -1 },
    };
    const steps = planInteractionTests({ traits: [trait], tests: [guardedPass, guardedFail] });
    expect(steps).toHaveLength(2);
    expect(steps[0].guardCase).toBe('pass');
    expect(steps[0].payload).toEqual({ qty: 5 });
    expect(steps[1].guardCase).toBe('fail');
    expect(steps[1].payload).toEqual({ qty: -1 });
  });

  it('skips tests whose trait is not in the traits list', () => {
    const orphan: InteractionTestSpec = { ...baseTest, trait: 'GhostTrait' };
    expect(planInteractionTests({ traits: [trait], tests: [orphan] })).toEqual([]);
  });

  it('returns [] for the empty test list', () => {
    expect(planInteractionTests({ traits: [trait], tests: [] })).toEqual([]);
  });
});
