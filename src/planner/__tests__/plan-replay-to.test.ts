import { describe, it, expect } from 'vitest';
import type { EdgeWalkTransition } from '@almadar/core';
import { planReplayTo } from '../plan-replay-to.js';
import type { TraitWalkConfig } from '../../engine/types.js';

function transition(from: string, event: string, to: string): EdgeWalkTransition {
  return { from, event, to, hasGuard: false };
}

describe('planReplayTo', () => {
  it('returns [] when target is the initial state', () => {
    const trait: TraitWalkConfig = {
      traitName: 'X',
      initialState: 'a',
      transitions: [transition('a', 'GO', 'b')],
    };
    expect(planReplayTo({ trait, targetState: 'a' })).toEqual([]);
  });

  it('returns the BFS shortest path to the target state', () => {
    const trait: TraitWalkConfig = {
      traitName: 'X',
      initialState: 'a',
      transitions: [
        transition('a', 'GO', 'b'),
        transition('b', 'NEXT', 'c'),
      ],
    };
    const steps = planReplayTo({ trait, targetState: 'c' });
    expect(steps).toHaveLength(2);
    expect(steps[0].event).toBe('GO');
    expect(steps[1].event).toBe('NEXT');
    for (const step of steps) {
      expect(step.triggerKind).toBe('replay');
      expect(step.isRepositioning).toBe(true);
      expect(step.coverageKey).toMatch(/\[replay\]$/);
    }
  });

  it('returns [] when the target is unreachable', () => {
    const trait: TraitWalkConfig = {
      traitName: 'X',
      initialState: 'a',
      transitions: [transition('a', 'GO', 'b')],
    };
    expect(planReplayTo({ trait, targetState: 'unreachable' })).toEqual([]);
  });
});
