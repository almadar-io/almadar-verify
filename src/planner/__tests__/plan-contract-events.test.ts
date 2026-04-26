import { describe, it, expect } from 'vitest';
import { planContractEvents } from '../plan-contract-events.js';
import type { TraitWalkConfig } from '../../engine/types.js';

const trait: TraitWalkConfig = {
  traitName: 'CartItemBrowse',
  initialState: 'browsing',
  transitions: [],
};

describe('planContractEvents', () => {
  it('emits one dom step per event, all anchored to the first trait', () => {
    const steps = planContractEvents({
      traits: [trait],
      events: ['SELECT_ITEM', 'UPDATE_ITEM', 'DELETE_ITEM'],
    });

    expect(steps).toHaveLength(3);
    for (const step of steps) {
      expect(step.triggerKind).toBe('dom');
      expect(step.testKind).toBe('contract');
      expect(step.traitName).toBe('CartItemBrowse');
      expect(step.from).toBe('browsing');
      expect(step.to).toBe('browsing');
      expect(step.coverageKey).toMatch(/\[contract\]$/);
    }
    expect(steps.map((s) => s.event).sort()).toEqual(['DELETE_ITEM', 'SELECT_ITEM', 'UPDATE_ITEM']);
  });

  it('deduplicates repeated event names', () => {
    const steps = planContractEvents({
      traits: [trait],
      events: ['SAVE', 'SAVE', 'SAVE'],
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].event).toBe('SAVE');
  });

  it('returns [] when traits is empty', () => {
    expect(planContractEvents({ traits: [], events: ['SAVE'] })).toEqual([]);
  });

  it('returns [] when events is empty', () => {
    expect(planContractEvents({ traits: [trait], events: [] })).toEqual([]);
  });
});
