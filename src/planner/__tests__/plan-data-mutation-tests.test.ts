import { describe, it, expect } from 'vitest';
import type { ReplayStep } from '@almadar/core';
import { planDataMutationTests, type DataMutationTestSpec } from '../plan-data-mutation-tests.js';
import type { TraitWalkConfig } from '../../engine/types.js';

const trait: TraitWalkConfig = {
  traitName: 'CartItemAddItem',
  initialState: 'idle',
  transitions: [],
};

describe('planDataMutationTests', () => {
  it('emits one dom step per test, tagged data-mutation, with expectedRowDelta', () => {
    const tests: DataMutationTestSpec[] = [
      {
        trait: 'CartItemAddItem',
        event: 'SAVE',
        fromState: 'form',
        linkedEntity: 'CartItem',
        mutationType: 'create',
        replayPath: [],
      },
    ];
    const steps = planDataMutationTests({ traits: [trait], tests });

    expect(steps).toHaveLength(1);
    expect(steps[0].triggerKind).toBe('dom');
    expect(steps[0].testKind).toBe('data-mutation');
    expect(steps[0].event).toBe('SAVE');
    expect(steps[0].expectedRowDelta).toEqual({ entityName: 'CartItem', delta: 1 });
    expect(steps[0].coverageKey).toMatch(/\[data-mutation:create\]/);
  });

  it('uses delta -1 for delete and 0 for update', () => {
    const tests: DataMutationTestSpec[] = [
      { trait: 'CartItemAddItem', event: 'CONFIRM_DELETE', fromState: 'confirming', linkedEntity: 'CartItem', mutationType: 'delete', replayPath: [] },
      { trait: 'CartItemAddItem', event: 'SAVE', fromState: 'form', linkedEntity: 'CartItem', mutationType: 'update', replayPath: [] },
    ];
    const steps = planDataMutationTests({ traits: [trait], tests });
    expect(steps).toHaveLength(2);
    expect(steps[0].expectedRowDelta?.delta).toBe(-1);
    expect(steps[1].expectedRowDelta?.delta).toBe(0);
  });

  it('expands replay paths inline as triggerKind: replay steps before the dom step', () => {
    const replayPath: ReplayStep[] = [
      { event: 'OPEN_DELETE', fromState: 'browsing', toState: 'confirming', slot: 'modal', needsEntityData: true },
    ];
    const tests: DataMutationTestSpec[] = [
      {
        trait: 'CartItemAddItem',
        event: 'CONFIRM_DELETE',
        fromState: 'confirming',
        linkedEntity: 'CartItem',
        mutationType: 'delete',
        replayPath,
      },
    ];
    const steps = planDataMutationTests({ traits: [trait], tests });

    expect(steps).toHaveLength(2);
    expect(steps[0].triggerKind).toBe('replay');
    expect(steps[0].event).toBe('OPEN_DELETE');
    expect(steps[0].isRepositioning).toBe(true);
    expect(steps[1].triggerKind).toBe('dom');
    expect(steps[1].event).toBe('CONFIRM_DELETE');
  });

  it('skips tests whose trait is not in the traits list', () => {
    const tests: DataMutationTestSpec[] = [
      { trait: 'GhostTrait', event: 'SAVE', fromState: 'form', linkedEntity: 'X', mutationType: 'create', replayPath: [] },
    ];
    expect(planDataMutationTests({ traits: [trait], tests })).toEqual([]);
  });

  it('returns [] for the empty test list', () => {
    expect(planDataMutationTests({ traits: [trait], tests: [] })).toEqual([]);
  });
});
