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
    // v3.14+: non-init transitions get a `[success]` suffix (no
    // required-payload events in std-browse → no `[malformed]`
    // variant). The auto-init step keeps the unsuffixed key.
    const steps = planWalk({ trait: stdBrowseTrait });
    for (const step of steps) {
      const suffix = step.triggerKind === 'auto-init' ? '' : '[success]';
      const expected = `BrowseItemBrowse:${step.from}+${step.event}->${step.to}${suffix}`;
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
      'BrowseItemBrowse:loading+BrowseItemLoaded->browsing[success]',
    );
    expect(nonReplayKeys).toContain(
      'BrowseItemBrowse:loading+BrowseItemLoadFailed->error[success]',
    );
    expect(nonReplayKeys).toContain(
      'BrowseItemBrowse:browsing+INIT->loading[success]',
    ); // refresh
    expect(nonReplayKeys).toContain(
      'BrowseItemBrowse:error+INIT->loading[success]',
    ); // retry
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

  it('handles a guarded transition by emitting [success] and [guard-fail] keys', () => {
    // v3.14+: guarded transitions emit `[success]` (guard.pass + valid
    // payload) and `[guard-fail]` (guard.fail + valid payload) variants.
    // The legacy `[pass]` / `[fail]` suffixes were replaced by the more
    // explicit payloadCase tags so observers can branch on intent
    // (validator-reject vs guard-reject vs success path) without
    // re-deriving from `payload` shape.
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
    expect(guardedKeys).toContain('Guarded:a+TRY->b[success]');
    expect(guardedKeys).toContain('Guarded:a+TRY->b[guard-fail]');
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

  describe('transient auto-advancing states (acceptStates)', () => {
    // `loading`'s entry fetch emits BrowseItemLoaded (→ browsing) on success
    // and BrowseItemLoadFailed (→ error) on failure: both effect-emitted, so
    // `loading` auto-advances and a transition INTO it settles past it.
    const asyncTrait: TraitWalkConfig = {
      ...stdBrowseTrait,
      effectEmittedEvents: new Set(['BrowseItemLoaded', 'BrowseItemLoadFailed']),
    };

    it('sets acceptStates to the transient closure for a transition into a transient state', () => {
      const steps = planWalk({ trait: asyncTrait, includeAutoInit: false });
      const refresh = steps.find((s) => s.from === 'browsing' && s.event === 'INIT' && s.to === 'loading');
      expect(refresh).toBeDefined();
      // closure(loading) = { loading, browsing, error }
      expect([...(refresh?.acceptStates ?? [])].sort()).toEqual(['browsing', 'error', 'loading']);
    });

    it('sets acceptStates to the from-closure for a step ON an effect-emitted event', () => {
      const steps = planWalk({ trait: asyncTrait, includeAutoInit: false });
      // `BrowseItemLoaded` is fired by the fetch effect, not a user. The manual
      // dispatch is a no-op nudge — the runtime is wherever the natural flow
      // settled, anywhere in `from`'s closure (= { loading, browsing, error }).
      const load = steps.find((s) => s.event === 'BrowseItemLoaded' && s.to === 'browsing' && s.payloadCase === 'success');
      expect(load).toBeDefined();
      expect([...(load?.acceptStates ?? [])].sort()).toEqual(['browsing', 'error', 'loading']);
    });

    it('excludes effect-emitted events from the replay graph (undrivable failure target)', async () => {
      const { planReplayTo } = await import('../plan-replay-to.js');
      // `error` is reachable only via `loading --BrowseItemLoadFailed--> error`,
      // an effect-emitted (fetch-failure) hop that can't be driven → no path.
      const replay = planReplayTo({ trait: asyncTrait, targetState: 'error' });
      expect(replay).toEqual([]);
    });

    it('omits acceptStates entirely when the trait declares no effect-emitted events', () => {
      const steps = planWalk({ trait: stdBrowseTrait, includeAutoInit: false });
      expect(steps.every((s) => s.acceptStates === undefined)).toBe(true);
    });
  });

  describe('guard steering honesty (guardSteerable)', () => {
    it('marks @entity-bound guard variants as unsteerable', () => {
      // Snake's steering guards bind @entity.* — the synthesized
      // `{pass:{},fail:{}}` payloads can't steer them.
      const entityGuarded: EdgeWalkTransition = {
        from: 'playing',
        event: 'UP',
        to: 'playing',
        hasGuard: true,
        guard: ['and', ['not', '@entity.over'], ['!=', '@entity.dir', 'down']],
      };
      const trait: TraitWalkConfig = {
        traitName: 'Snake',
        initialState: 'playing',
        transitions: [entityGuarded],
      };
      const steps = planWalk({ trait, includeAutoInit: false });
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step.guardSteerable).toBe(false);
      }
    });

    it('marks @config-bound guard variants as unsteerable', () => {
      const configGuarded: EdgeWalkTransition = {
        from: 'a',
        event: 'GO',
        to: 'b',
        hasGuard: true,
        guard: ['=', '@config.mode', 'edit'],
      };
      const trait: TraitWalkConfig = {
        traitName: 'Cfg',
        initialState: 'a',
        transitions: [configGuarded],
      };
      const steps = planWalk({ trait, includeAutoInit: false });
      expect(steps.every((s) => s.guardSteerable === false)).toBe(true);
    });

    it('leaves @payload-bound guard variants steerable', () => {
      const payloadGuarded: EdgeWalkTransition = {
        from: 'a',
        event: 'TRY',
        to: 'b',
        hasGuard: true,
        guard: ['gt', '@payload.qty', 0],
      };
      const trait: TraitWalkConfig = {
        traitName: 'Guarded',
        initialState: 'a',
        transitions: [payloadGuarded],
      };
      const steps = planWalk({ trait, includeAutoInit: false });
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step.guardSteerable).toBe(true);
      }
    });

    it('a guard mixing @payload and @entity is unsteerable (entity side unreachable)', () => {
      const mixed: EdgeWalkTransition = {
        from: 'a',
        event: 'TRY',
        to: 'b',
        hasGuard: true,
        guard: ['and', ['gt', '@payload.qty', 0], ['not', '@entity.over']],
      };
      const trait: TraitWalkConfig = {
        traitName: 'Mixed',
        initialState: 'a',
        transitions: [mixed],
      };
      const steps = planWalk({ trait, includeAutoInit: false });
      expect(steps.every((s) => s.guardSteerable === false)).toBe(true);
    });

    it('unguarded steps carry no guardSteerable stamp', () => {
      const steps = planWalk({ trait: stdBrowseTrait });
      expect(steps.every((s) => s.guardSteerable === undefined)).toBe(true);
    });
  });
});
