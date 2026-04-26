import { describe, it, expect } from 'vitest';
import { planInitCredit } from '../plan-init-credit.js';
import type { TraitWalkConfig } from '../../engine/types.js';

describe('planInitCredit', () => {
  it('produces the auto-init step for the trait', () => {
    const trait: TraitWalkConfig = {
      traitName: 'BrowseItemBrowse',
      initialState: 'loading',
      transitions: [],
    };
    const step = planInitCredit(trait);
    expect(step.triggerKind).toBe('auto-init');
    expect(step.event).toBe('INIT');
    expect(step.from).toBe('loading');
    expect(step.to).toBe('loading');
    expect(step.coverageKey).toBe('BrowseItemBrowse:loading+INIT->loading');
    expect(step.isRepositioning).toBe(false);
    expect(step.guardCase).toBeNull();
  });

  it('respects a non-default initial state', () => {
    const trait: TraitWalkConfig = {
      traitName: 'X',
      initialState: 'idle',
      transitions: [],
    };
    const step = planInitCredit(trait);
    expect(step.from).toBe('idle');
    expect(step.to).toBe('idle');
    expect(step.coverageKey).toBe('X:idle+INIT->idle');
  });
});
