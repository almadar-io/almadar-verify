import { describe, it, expect } from 'vitest';
import type { TransitionTrace, VerificationSnapshot } from '@almadar/core';
import { coverage } from '../coverage.js';
import type { Frame, FrameCause } from '../../frame/types.js';
import type { ExtendedWalkStep } from '../../planner/types.js';

const emptySnapshot: VerificationSnapshot = {
  checks: [],
  transitions: [],
  bridge: null,
  summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
  traits: [],
};
const emptyDom = { url: '', rowsByEntity: {}, portals: [], visibleTextSample: '' };

function snapshotWithTransition(
  traitName: string,
  from: string,
  event: string,
  to: string,
): VerificationSnapshot {
  const tx: TransitionTrace = {
    id: `tx-${traitName}-${event}`,
    traitName,
    from,
    to,
    event,
    effects: [],
    timestamp: 2000,
  };
  return { ...emptySnapshot, transitions: [tx] };
}

function frame(cause: FrameCause, index: number, snapshot: VerificationSnapshot = emptySnapshot): Frame {
  return {
    index,
    timestamp: 1000 + index,
    cause,
    stateBefore: cause.from,
    stateAfter: cause.to,
    payload: {},
    eventFired: cause.event,
    runtimeSnapshot: snapshot,
    domSnapshot: emptyDom,
    consoleDelta: { added: [], newErrors: 0, newWarnings: 0 },
    eventLogDelta: { added: [] },
    entityChanges: [],
    effectResults: [],
    serverResponse: null,
    screenshotPath: null,
    accepted: true,
    errors: [],
    warnings: [],
  };
}

function step(
  trait: string,
  from: string,
  event: string,
  to: string,
  triggerKind: ExtendedWalkStep['triggerKind'],
  guardCase: 'pass' | 'fail' | null = null,
): ExtendedWalkStep {
  const suffix = guardCase === null ? '' : `[${guardCase}]`;
  return {
    from,
    event,
    to,
    guardCase,
    payload: {},
    isRepositioning: triggerKind === 'replay',
    traitName: trait,
    triggerKind,
    coverageKey: `${trait}:${from}+${event}->${to}${suffix}`,
  };
}

describe('coverage', () => {
  it('reports 100% when every plan key has a matching frame', () => {
    const plan: ExtendedWalkStep[] = [
      step('X', 'a', 'INIT', 'a', 'auto-init'),
      step('X', 'a', 'GO', 'b', 'bus'),
    ];
    const frames: Frame[] = [
      frame({ traitName: 'X', from: 'a', event: 'INIT', to: 'a', guardCase: null, triggerKind: 'auto-init', isRepositioning: false }, 0),
      frame({ traitName: 'X', from: 'a', event: 'GO', to: 'b', guardCase: null, triggerKind: 'bus', isRepositioning: false }, 1),
    ];
    const c = coverage(frames, plan);
    expect(c.totalItems).toBe(2);
    expect(c.coveredItems).toBe(2);
    expect(c.ratio).toBe(1);
    expect(c.uncovered).toEqual([]);
  });

  it('reports 0% when frames cover nothing in the plan', () => {
    const plan: ExtendedWalkStep[] = [step('X', 'a', 'GO', 'b', 'bus')];
    const c = coverage([], plan);
    expect(c.totalItems).toBe(1);
    expect(c.coveredItems).toBe(0);
    expect(c.ratio).toBe(0);
    expect(c.uncovered).toEqual(['X:a+GO->b']);
  });

  it('only credits frames whose key is in the plan', () => {
    const plan: ExtendedWalkStep[] = [step('X', 'a', 'GO', 'b', 'bus')];
    const frames: Frame[] = [
      frame({ traitName: 'X', from: 'a', event: 'GO', to: 'b', guardCase: null, triggerKind: 'bus', isRepositioning: false }, 0),
      // Off-plan frame — should not affect numerator OR denominator.
      frame({ traitName: 'OTHER', from: 'x', event: 'Y', to: 'z', guardCase: null, triggerKind: 'bus', isRepositioning: false }, 1),
    ];
    const c = coverage(frames, plan);
    expect(c.totalItems).toBe(1);
    expect(c.coveredItems).toBe(1);
  });

  it('breaks down coverage per trait', () => {
    const plan: ExtendedWalkStep[] = [
      step('A', 'x', 'GO', 'y', 'bus'),
      step('A', 'y', 'BACK', 'x', 'bus'),
      step('B', 'p', 'GO', 'q', 'bus'),
    ];
    const frames: Frame[] = [
      frame({ traitName: 'A', from: 'x', event: 'GO', to: 'y', guardCase: null, triggerKind: 'bus', isRepositioning: false }, 0),
    ];
    const c = coverage(frames, plan);
    expect(c.perTrait.A.total).toBe(2);
    expect(c.perTrait.A.covered).toBe(1);
    expect(c.perTrait.A.uncoveredKeys).toEqual(['A:y+BACK->x']);
    expect(c.perTrait.B.total).toBe(1);
    expect(c.perTrait.B.covered).toBe(0);
  });

  it('breaks down coverage per trigger kind', () => {
    const plan: ExtendedWalkStep[] = [
      step('X', 'a', 'INIT', 'a', 'auto-init'),
      step('X', 'a', 'GO', 'b', 'bus'),
      step('X', 'b', 'CLICK', 'c', 'dom'),
    ];
    const frames: Frame[] = [
      frame({ traitName: 'X', from: 'a', event: 'INIT', to: 'a', guardCase: null, triggerKind: 'auto-init', isRepositioning: false }, 0),
      frame({ traitName: 'X', from: 'a', event: 'GO', to: 'b', guardCase: null, triggerKind: 'bus', isRepositioning: false }, 1),
    ];
    const c = coverage(frames, plan);
    expect(c.perTriggerKind['auto-init']).toEqual({ total: 1, covered: 1 });
    expect(c.perTriggerKind.bus).toEqual({ total: 1, covered: 1 });
    expect(c.perTriggerKind.dom).toEqual({ total: 1, covered: 0 });
    expect(c.perTriggerKind.replay).toEqual({ total: 0, covered: 0 });
  });

  it('std-browse: 5/5 = 100% when all frames land', () => {
    // Pin the post-fix behavior: prepended auto-init + 4 walker steps
    // (LOADED, browsing+INIT, LOAD_FAILED, error+INIT) all in plan and all covered.
    const plan: ExtendedWalkStep[] = [
      step('BrowseItemBrowse', 'loading', 'INIT', 'loading', 'auto-init'),
      step('BrowseItemBrowse', 'loading', 'BrowseItemLoaded', 'browsing', 'bus'),
      step('BrowseItemBrowse', 'browsing', 'INIT', 'loading', 'bus'),
      step('BrowseItemBrowse', 'loading', 'BrowseItemLoadFailed', 'error', 'bus'),
      step('BrowseItemBrowse', 'error', 'INIT', 'loading', 'bus'),
    ];
    const frames: Frame[] = plan.map((s, i) =>
      frame({
        traitName: s.traitName,
        from: s.from,
        event: s.event,
        to: s.to,
        guardCase: s.guardCase,
        triggerKind: s.triggerKind,
        isRepositioning: false,
      }, i),
    );
    const c = coverage(frames, plan);
    expect(c.totalItems).toBe(5);
    expect(c.coveredItems).toBe(5);
    expect(c.ratio).toBe(1);
  });

  it('handles the empty plan', () => {
    const c = coverage([], []);
    expect(c.totalItems).toBe(0);
    expect(c.coveredItems).toBe(0);
    expect(c.ratio).toBe(0);
  });

  // V-3: server-emit cascade credit. The walker can't directly dispatch
  // events that have no DOM affordance (e.g. XLoaded fired by a fetch's
  // emit.success). Those transitions still land in the cascading frame's
  // runtimeSnapshot.transitions[]. Coverage should credit a planned key
  // when the transition is observed there, even if no frame's cause is
  // that transition.
  it('credits planned key when transition fires on the server cascade (success variant)', () => {
    const plan: ExtendedWalkStep[] = [
      step('Browse', 'loading', 'INIT', 'loading', 'auto-init'),
      // Plan key the walker can't dispatch — emit.success only.
      {
        ...step('Browse', 'loading', 'XLoaded', 'browsing', 'bus'),
        coverageKey: 'Browse:loading+XLoaded->browsing[success]',
        payloadCase: 'success',
      },
    ];
    const autoInit = frame({
      traitName: 'Browse',
      from: 'loading',
      event: 'INIT',
      to: 'loading',
      guardCase: null,
      triggerKind: 'auto-init',
      isRepositioning: false,
    }, 0);
    // Auto-init's snapshot contains the cascading XLoaded transition
    // — the fetch's emit.success fired and was recorded.
    const withCascade = frame(
      {
        traitName: 'Other',
        from: 'a',
        event: 'TICK',
        to: 'a',
        guardCase: null,
        triggerKind: 'bus',
        isRepositioning: false,
      },
      1,
      snapshotWithTransition('Browse', 'loading', 'XLoaded', 'browsing'),
    );
    const c = coverage([autoInit, withCascade], plan);
    expect(c.totalItems).toBe(2);
    expect(c.coveredItems).toBe(2);
    expect(c.uncovered).toEqual([]);
  });

  it('credits planned base key (no payload variant) when transition fires on cascade', () => {
    const plan: ExtendedWalkStep[] = [
      step('Browse', 'loading', 'XLoaded', 'browsing', 'bus'),
    ];
    const f = frame(
      {
        traitName: 'Browse',
        from: 'loading',
        event: 'INIT',
        to: 'loading',
        guardCase: null,
        triggerKind: 'auto-init',
        isRepositioning: false,
      },
      0,
      snapshotWithTransition('Browse', 'loading', 'XLoaded', 'browsing'),
    );
    const c = coverage([f], plan);
    expect(c.coveredItems).toBe(1);
  });

  it('cascade credit does NOT over-credit: only planned keys are added', () => {
    const plan: ExtendedWalkStep[] = [
      step('Browse', 'loading', 'INIT', 'loading', 'auto-init'),
    ];
    const f = frame(
      {
        traitName: 'Browse',
        from: 'loading',
        event: 'INIT',
        to: 'loading',
        guardCase: null,
        triggerKind: 'auto-init',
        isRepositioning: false,
      },
      0,
      // Cascade includes XLoaded but the plan never asked for it —
      // must NOT inflate the numerator beyond the planned key.
      snapshotWithTransition('Browse', 'loading', 'XLoaded', 'browsing'),
    );
    const c = coverage([f], plan);
    expect(c.totalItems).toBe(1);
    expect(c.coveredItems).toBe(1);
  });

  it('cascade credit does not double-count a key the walker also dispatched directly', () => {
    const plan: ExtendedWalkStep[] = [
      step('Browse', 'loading', 'INIT', 'loading', 'auto-init'),
      {
        ...step('Browse', 'loading', 'XLoaded', 'browsing', 'bus'),
        coverageKey: 'Browse:loading+XLoaded->browsing[success]',
        payloadCase: 'success',
      },
    ];
    // Walker dispatched XLoaded directly AND it also landed in the
    // cascade — still 1 covered item, not 2.
    const f1 = frame({
      traitName: 'Browse',
      from: 'loading',
      event: 'INIT',
      to: 'loading',
      guardCase: null,
      triggerKind: 'auto-init',
      isRepositioning: false,
      coverageKey: 'Browse:loading+INIT->loading',
    }, 0);
    const f2 = frame(
      {
        traitName: 'Browse',
        from: 'loading',
        event: 'XLoaded',
        to: 'browsing',
        guardCase: null,
        triggerKind: 'bus',
        isRepositioning: false,
        coverageKey: 'Browse:loading+XLoaded->browsing[success]',
        payloadCase: 'success',
      },
      1,
      snapshotWithTransition('Browse', 'loading', 'XLoaded', 'browsing'),
    );
    const c = coverage([f1, f2], plan);
    expect(c.coveredItems).toBe(2);
  });

  describe('schema-reconciled denominator (schemaTransitionKeys supplied)', () => {
    // The plan fans every transition out into variant steps (success /
    // malformed / guard-fail); the headline number must collapse those
    // onto the schema transition and add planned tick steps — one honest
    // covered/total against the schema.
    const schemaKeys = [
      'Browse:loading+INIT->loading',
      'Browse:loading+XLoaded->browsing',
      'Browse:loading+XLoadFailed->error',
    ];
    const plan: ExtendedWalkStep[] = [
      step('Browse', 'loading', 'INIT', 'loading', 'auto-init'),
      {
        ...step('Browse', 'loading', 'XLoaded', 'browsing', 'bus'),
        coverageKey: 'Browse:loading+XLoaded->browsing[success]',
        payloadCase: 'success',
      },
      {
        ...step('Browse', 'loading', 'XLoaded', 'browsing', 'bus'),
        coverageKey: 'Browse:loading+XLoaded->browsing[malformed]',
        payloadCase: 'malformed',
      },
      {
        ...step('Browse', 'loading', 'XLoadFailed', 'error', 'bus'),
        coverageKey: 'Browse:loading+XLoadFailed->error[success]',
        payloadCase: 'success',
      },
      {
        ...step('Browse', 'playing', 'step', 'playing', 'tick'),
        coverageKey: 'Browse:tick(step)',
        waitMs: 150,
      },
    ];

    it('counts schema transitions + tick steps as the total, not plan variant keys', () => {
      const frames: Frame[] = [
        frame({ traitName: 'Browse', from: 'loading', event: 'INIT', to: 'loading', guardCase: null, triggerKind: 'auto-init', isRepositioning: false, coverageKey: 'Browse:loading+INIT->loading' }, 0),
        frame({ traitName: 'Browse', from: 'loading', event: 'XLoaded', to: 'browsing', guardCase: null, triggerKind: 'bus', isRepositioning: false, coverageKey: 'Browse:loading+XLoaded->browsing[success]', payloadCase: 'success' }, 1),
        frame({ traitName: 'Browse', from: 'loading', event: 'XLoadFailed', to: 'error', guardCase: null, triggerKind: 'bus', isRepositioning: false, coverageKey: 'Browse:loading+XLoadFailed->error[success]', payloadCase: 'success' }, 2),
        frame({ traitName: 'Browse', from: 'playing', event: 'step', to: 'playing', guardCase: null, triggerKind: 'tick', isRepositioning: false, coverageKey: 'Browse:tick(step)' }, 3),
      ];
      const c = coverage(frames, plan, 3, schemaKeys);
      expect(c.totalItems).toBe(4); // 3 schema transitions + 1 tick step
      expect(c.coveredItems).toBe(4);
      expect(c.ratio).toBe(1);
      expect(c.uncovered).toEqual([]);
    });

    it('a transition with ANY covered variant counts as covered', () => {
      // Only the [success] variant of XLoaded ran — the [malformed] one
      // didn't — but the schema transition is still covered.
      const frames: Frame[] = [
        frame({ traitName: 'Browse', from: 'loading', event: 'XLoaded', to: 'browsing', guardCase: null, triggerKind: 'bus', isRepositioning: false, coverageKey: 'Browse:loading+XLoaded->browsing[success]', payloadCase: 'success' }, 0),
      ];
      const c = coverage(frames, plan, 3, schemaKeys);
      expect(c.totalItems).toBe(4);
      expect(c.coveredItems).toBe(1);
      expect([...c.uncovered].sort()).toEqual([
        'Browse:loading+INIT->loading',
        'Browse:loading+XLoadFailed->error',
        'Browse:tick(step)',
      ]);
    });

    it('reports schema transitions the plan never walked as uncovered', () => {
      const frames: Frame[] = [
        frame({ traitName: 'Browse', from: 'loading', event: 'INIT', to: 'loading', guardCase: null, triggerKind: 'auto-init', isRepositioning: false, coverageKey: 'Browse:loading+INIT->loading' }, 0),
      ];
      // Plan has no steps for XLoadFailed at all — under-covering plan.
      const partialPlan = plan.filter((s) => !s.coverageKey.includes('XLoadFailed'));
      const c = coverage(frames, partialPlan, 3, schemaKeys);
      expect(c.coveredItems).toBe(1);
      expect(c.uncovered).toContain('Browse:loading+XLoadFailed->error');
      expect(c.ratio).toBeCloseTo(1 / 4);
    });

    it('per-trait breakdown follows the schema denominator', () => {
      const c = coverage([], plan, 3, schemaKeys);
      expect(c.perTrait.Browse.total).toBe(4);
      expect(c.perTrait.Browse.covered).toBe(0);
      expect(c.perTrait.Browse.uncoveredKeys).toHaveLength(4);
    });

    it('legacy plan-key accounting is preserved when no schema keys are supplied', () => {
      const c = coverage([], plan, 3);
      // 5 distinct plan keys (INIT base, 3 variants, 1 tick).
      expect(c.totalItems).toBe(5);
      expect(c.coveredItems).toBe(0);
    });
  });
});
