import { describe, it, expect } from 'vitest';
import type { VerificationSnapshot } from '@almadar/core';
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

function frame(cause: FrameCause, index: number): Frame {
  return {
    index,
    timestamp: 1000 + index,
    cause,
    stateBefore: cause.from,
    stateAfter: cause.to,
    payload: {},
    eventFired: cause.event,
    runtimeSnapshot: emptySnapshot,
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
});
