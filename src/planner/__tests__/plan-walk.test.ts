/**
 * Tests for `planWalk` — the centerpiece planner.
 *
 * The std-browse fixture is the gold-standard regression: 3/5 → 5/5
 * coverage when the @almadar/core INIT-filter fix lands. Pinning the
 * exact step set here means any future drift gets caught immediately.
 */

import { describe, it, expect } from 'vitest';
import type { EdgeWalkTransition } from '@almadar/core';
import { planWalk } from '../plan-walk.js';
import type { TraitWalkConfig } from '../../engine/types.js';

function transition(from: string, event: string, to: string): EdgeWalkTransition {
  return { from, event, to, hasGuard: false };
}

const stdBrowseTrait: TraitWalkConfig = {
  traitName: 'BrowseItemBrowse',
  initialState: 'loading',
  transitions: [
    transition('loading', 'INIT', 'loading'),                     // boot
    transition('loading', 'BrowseItemLoaded', 'browsing'),
    transition('loading', 'BrowseItemLoadFailed', 'error'),
    transition('browsing', 'INIT', 'loading'),                    // refresh
    transition('error', 'INIT', 'loading'),                       // retry
  ],
};

describe('planWalk', () => {
  it('prepends the synthetic auto-init step by default', () => {
    const steps = planWalk({ trait: stdBrowseTrait });
    expect(steps[0].triggerKind).toBe('auto-init');
    expect(steps[0].event).toBe('INIT');
    expect(steps[0].from).toBe('loading');
    expect(steps[0].to).toBe('loading');
    expect(steps[0].coverageKey).toBe(
      'BrowseItemBrowse:loading+INIT->loading',
    );
  });

  it('skips the auto-init step when includeAutoInit is false', () => {
    const steps = planWalk({ trait: stdBrowseTrait, includeAutoInit: false });
    expect(steps.every((s) => s.triggerKind !== 'auto-init')).toBe(true);
  });

  it('every non-init step is tagged bus or replay', () => {
    const steps = planWalk({ trait: stdBrowseTrait });
    for (const step of steps) {
      expect(['auto-init', 'bus', 'replay']).toContain(step.triggerKind);
    }
  });

  it('emits stable coverage keys matching frame/keyOf', () => {
    const steps = planWalk({ trait: stdBrowseTrait });
    for (const step of steps) {
      const expected = `BrowseItemBrowse:${step.from}+${step.event}->${step.to}`;
      expect(step.coverageKey).toBe(expected);
    }
  });

  it('std-browse: covers all 4 walkable edges (boot INIT excluded)', () => {
    const steps = planWalk({ trait: stdBrowseTrait });
    const nonReplayKeys = steps
      .filter((s) => !s.isRepositioning)
      .map((s) => s.coverageKey);

    expect(nonReplayKeys).toContain(
      'BrowseItemBrowse:loading+INIT->loading',
    ); // auto-init
    expect(nonReplayKeys).toContain(
      'BrowseItemBrowse:loading+BrowseItemLoaded->browsing',
    );
    expect(nonReplayKeys).toContain(
      'BrowseItemBrowse:loading+BrowseItemLoadFailed->error',
    );
    expect(nonReplayKeys).toContain(
      'BrowseItemBrowse:browsing+INIT->loading',
    ); // refresh — invisible pre-fix
    expect(nonReplayKeys).toContain(
      'BrowseItemBrowse:error+INIT->loading',
    ); // retry — invisible pre-fix
  });

  it('handles a trait with no INIT transitions', () => {
    const trait: TraitWalkConfig = {
      traitName: 'X',
      initialState: 'a',
      transitions: [transition('a', 'GO', 'b')],
    };
    const steps = planWalk({ trait });
    // 1 auto-init + 1 walker step
    expect(steps).toHaveLength(2);
    expect(steps[0].triggerKind).toBe('auto-init');
    expect(steps[1].event).toBe('GO');
  });

  it('handles a guarded transition by emitting [pass] and [fail] keys', () => {
    // Guard uses `gt` (one of the operators buildGuardPayloads understands).
    // The trait needs a way back to `a` so the walker can attempt both
    // pass and fail cases — without a return edge, after [pass] fires
    // and lands at `b`, there's no path back to `a` to try [fail].
    const guarded: EdgeWalkTransition = {
      from: 'a',
      event: 'TRY',
      to: 'b',
      hasGuard: true,
      guard: ['gt', '@payload.qty', 0],
    };
    const trait: TraitWalkConfig = {
      traitName: 'Guarded',
      initialState: 'a',
      transitions: [guarded, transition('b', 'BACK', 'a')],
    };
    const steps = planWalk({ trait });
    const guardedKeys = steps
      .filter((s) => s.event === 'TRY')
      .map((s) => s.coverageKey);
    expect(guardedKeys).toContain('Guarded:a+TRY->b[pass]');
    expect(guardedKeys).toContain('Guarded:a+TRY->b[fail]');
  });

  it('std-browse needs no replays — every edge is reachable in greedy DFS', () => {
    // After the @almadar/core 5.9.0 INIT-filter fix, the std-browse
    // graph is fully reachable via greedy DFS from `loading`:
    //   loading → BrowseItemLoaded → browsing → INIT → loading
    //          → BrowseItemLoadFailed → error → INIT → loading
    // No BFS repositioning needed. Steps should be all bus + auto-init.
    const steps = planWalk({ trait: stdBrowseTrait });
    const replays = steps.filter((s) => s.triggerKind === 'replay');
    expect(replays).toHaveLength(0);
    const triggerKinds = new Set(steps.map((s) => s.triggerKind));
    expect(triggerKinds.has('auto-init')).toBe(true);
    expect(triggerKinds.has('bus')).toBe(true);
  });
});
