import { describe, it, expect } from 'vitest';
import type { VerificationSnapshot } from '@almadar/core';
import type { TransitionTrace } from '@almadar/core';
import { assertPortalPerStep, assertTransientFailureArmPortals, assertSlotShowsForeignTransitionRender } from '../assert-portal-per-step.js';
import type { PortalExpectation } from '../types.js';
import type { DomSnapshot, Frame, FrameCause } from '../../frame/types.js';
import type { PortalSlot } from '../../browser/portal-slots.js';

const emptySnapshot: VerificationSnapshot = {
  checks: [],
  transitions: [],
  bridge: null,
  summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
  traits: [],
};

function dom(portals: ReadonlyArray<{ slot: PortalSlot; mounted: boolean; childCount: number; pattern?: string }>): DomSnapshot {
  return { url: '', rowsByEntity: {}, portals, visibleTextSample: '' };
}

const cause = (
  trait: string,
  from: string,
  event: string,
  to: string,
  opts: {
    isRepositioning?: boolean;
    guardCase?: 'pass' | 'fail' | null;
    verifiesPortalFor?: { traitName: string; from: string; event: string; to: string };
  } = {},
): FrameCause => ({
  traitName: trait,
  from,
  event,
  to,
  guardCase: opts.guardCase ?? null,
  triggerKind: 'bus',
  isRepositioning: opts.isRepositioning ?? false,
  ...(opts.verifiesPortalFor !== undefined && { verifiesPortalFor: opts.verifiesPortalFor }),
});

function transitionTrace(traitName: string, from: string, event: string, to: string): TransitionTrace {
  return { id: `${traitName}-${event}`, traitName, from, to, event, effects: [], timestamp: Date.now() };
}

function frame(
  index: number,
  c: FrameCause,
  domSnapshot: DomSnapshot,
  accepted = true,
  transitions: ReadonlyArray<TransitionTrace> = [],
): Frame {
  return {
    index,
    timestamp: 1000 + index,
    cause: c,
    stateBefore: c.from,
    stateAfter: c.to,
    payload: {},
    eventFired: c.event,
    runtimeSnapshot: transitions.length > 0 ? { ...emptySnapshot, transitions: [...transitions] } : emptySnapshot,
    domSnapshot,
    consoleDelta: { added: [], newErrors: 0, newWarnings: 0 },
    eventLogDelta: { added: [] },
    entityChanges: [],
    effectResults: [],
    serverResponse: null,
    screenshotPath: null,
    accepted,
    errors: [],
    warnings: [],
  };
}

describe('assertPortalPerStep', () => {
  it('returns [] when expectations is empty', () => {
    expect(assertPortalPerStep([], [])).toEqual([]);
  });

  it('passes when the matching frame shows the expected pattern mounted with childCount > 0', () => {
    const expectations: PortalExpectation[] = [
      { traitName: 'X', from: 'a', event: 'OPEN', to: 'b', slot: 'modal', pattern: 'modal' },
    ];
    const frames: Frame[] = [
      frame(0, cause('X', 'a', 'OPEN', 'b'), dom([{ slot: 'modal', mounted: true, childCount: 1 }])),
    ];
    const verdicts = assertPortalPerStep(frames, expectations);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(true);
  });

  it('fails when the slot is mounted but empty (blank-portal bug)', () => {
    const expectations: PortalExpectation[] = [
      { traitName: 'X', from: 'a', event: 'OPEN', to: 'b', slot: 'modal', pattern: 'modal' },
    ];
    const frames: Frame[] = [
      frame(0, cause('X', 'a', 'OPEN', 'b'), dom([{ slot: 'modal', mounted: true, childCount: 0 }])),
    ];
    const verdicts = assertPortalPerStep(frames, expectations);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/blank-portal/);
  });

  it('fails when the slot is not mounted', () => {
    const expectations: PortalExpectation[] = [
      { traitName: 'X', from: 'a', event: 'OPEN', to: 'b', slot: 'modal', pattern: 'modal' },
    ];
    const frames: Frame[] = [
      frame(0, cause('X', 'a', 'OPEN', 'b'), dom([])),
    ];
    const verdicts = assertPortalPerStep(frames, expectations);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/slot not mounted/);
  });

  it('passes a `pattern: null` (clear-slot) expectation when slot is empty', () => {
    const expectations: PortalExpectation[] = [
      { traitName: 'X', from: 'b', event: 'CLOSE', to: 'a', slot: 'modal', pattern: null },
    ];
    const frames: Frame[] = [
      frame(0, cause('X', 'b', 'CLOSE', 'a'), dom([])),
    ];
    const verdicts = assertPortalPerStep(frames, expectations);
    expect(verdicts[0].passed).toBe(true);
  });

  it('fails a `pattern: null` expectation when slot is still mounted with content', () => {
    const expectations: PortalExpectation[] = [
      { traitName: 'X', from: 'b', event: 'CLOSE', to: 'a', slot: 'modal', pattern: null },
    ];
    const frames: Frame[] = [
      frame(0, cause('X', 'b', 'CLOSE', 'a'), dom([{ slot: 'modal', mounted: true, childCount: 2 }])),
    ];
    const verdicts = assertPortalPerStep(frames, expectations);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/expected slot "modal" to be empty/);
  });

  it('skips frames that did not accept (no verdict for guard-fail or rejected steps)', () => {
    const expectations: PortalExpectation[] = [
      { traitName: 'X', from: 'a', event: 'GO', to: 'b', slot: 'center', pattern: 'list' },
    ];
    const frames: Frame[] = [
      frame(0, cause('X', 'a', 'GO', 'b'), dom([{ slot: 'center', mounted: true, childCount: 1 }]), false),
      frame(1, cause('X', 'a', 'GO', 'b', { guardCase: 'fail' }), dom([])),
      frame(2, cause('X', 'a', 'GO', 'b', { isRepositioning: true }), dom([])),
    ];
    const verdicts = assertPortalPerStep(frames, expectations);
    expect(verdicts).toHaveLength(0);
  });

  it('only emits verdicts for frames that match the expectation by (trait, from, event, to)', () => {
    const expectations: PortalExpectation[] = [
      { traitName: 'X', from: 'a', event: 'OPEN', to: 'b', slot: 'modal', pattern: 'modal' },
    ];
    const frames: Frame[] = [
      frame(0, cause('Y', 'a', 'OPEN', 'b'), dom([])),    // wrong trait
      frame(1, cause('X', 'a', 'CLOSE', 'b'), dom([])),  // wrong event
      frame(2, cause('X', 'a', 'OPEN', 'b'), dom([{ slot: 'modal', mounted: true, childCount: 1 }])), // matches
    ];
    const verdicts = assertPortalPerStep(frames, expectations);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(true);
  });
});

describe('assertTransientFailureArmPortals (RV item 27)', () => {
  const expectation: PortalExpectation = {
    traitName: 'DirectMessageStarter', from: 'creating', event: 'DmChannelCreateFailed', to: 'idle',
    slot: 'toast', pattern: 'alert',
  };

  it('returns [] when expectations is empty', () => {
    expect(assertTransientFailureArmPortals([], [])).toEqual([]);
  });

  it('ignores frames with no verifiesPortalFor — never matches a plain dispatch by coincidence', () => {
    const frames: Frame[] = [
      frame(0, cause('DirectMessageStarter', 'idle', 'START_DM', 'creating'), dom([])),
    ];
    expect(assertTransientFailureArmPortals(frames, [expectation])).toEqual([]);
  });

  it('passes when the probed frame carries the matching arm in runtimeSnapshot.transitions and the portal is mounted', () => {
    const frames: Frame[] = [
      frame(
        0,
        cause('DirectMessageStarter', 'idle', 'START_DM', 'creating', {
          verifiesPortalFor: { traitName: 'DirectMessageStarter', from: 'creating', event: 'DmChannelCreateFailed', to: 'idle' },
        }),
        dom([{ slot: 'toast', mounted: true, childCount: 1 }]),
        true,
        [transitionTrace('DirectMessageStarter', 'creating', 'DmChannelCreateFailed', 'idle')],
      ),
    ];
    const verdicts = assertTransientFailureArmPortals(frames, [expectation]);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(true);
  });

  it('fails honestly — never "slot not mounted" — when the forced dispatch never actually reproduced the arm', () => {
    const frames: Frame[] = [
      frame(
        0,
        cause('DirectMessageStarter', 'idle', 'START_DM', 'creating', {
          verifiesPortalFor: { traitName: 'DirectMessageStarter', from: 'creating', event: 'DmChannelCreateFailed', to: 'idle' },
        }),
        dom([]),
        true,
        [], // the denying viewer did not actually deny — no matching trace
      ),
    ];
    const verdicts = assertTransientFailureArmPortals(frames, [expectation]);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/did not reproduce the failure/);
    expect(verdicts[0].detail).not.toMatch(/slot not mounted/);
  });

  it('fails when the arm fired but the portal never mounted', () => {
    const frames: Frame[] = [
      frame(
        0,
        cause('DirectMessageStarter', 'idle', 'START_DM', 'creating', {
          verifiesPortalFor: { traitName: 'DirectMessageStarter', from: 'creating', event: 'DmChannelCreateFailed', to: 'idle' },
        }),
        dom([]),
        true,
        [transitionTrace('DirectMessageStarter', 'creating', 'DmChannelCreateFailed', 'idle')],
      ),
    ];
    const verdicts = assertTransientFailureArmPortals(frames, [expectation]);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/slot not mounted/);
  });
});

describe('assertSlotShowsForeignTransitionRender', () => {
  const expectations: PortalExpectation[] = [
    { traitName: 'X', from: 'a', event: 'OPEN_A', to: 'b', slot: 'modal', pattern: 'confirm-dialog' },
    { traitName: 'X', from: 'c', event: 'OPEN_B', to: 'd', slot: 'modal', pattern: 'modal' },
  ];

  it('returns [] when expectations is empty', () => {
    expect(assertSlotShowsForeignTransitionRender([], [])).toEqual([]);
  });

  it('passes silently when the observed pattern matches the firing transition\'s own declared pattern', () => {
    const frames: Frame[] = [
      frame(0, cause('X', 'a', 'OPEN_A', 'b'), dom([{ slot: 'modal', mounted: true, childCount: 1, pattern: 'confirm-dialog' }])),
    ];
    expect(assertSlotShowsForeignTransitionRender(frames, expectations)).toEqual([]);
  });

  it('flags a foreign render — the DOM shows a DIFFERENT declared writer\'s own pattern', () => {
    const frames: Frame[] = [
      frame(0, cause('X', 'a', 'OPEN_A', 'b'), dom([{ slot: 'modal', mounted: true, childCount: 1, pattern: 'modal' }])),
    ];
    const verdicts = assertSlotShowsForeignTransitionRender(frames, expectations);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/authored by X\.OPEN_B, not the last writer/);
  });

  it('stays silent when the observed pattern matches no known declared writer at all (not attributable)', () => {
    const frames: Frame[] = [
      frame(0, cause('X', 'a', 'OPEN_A', 'b'), dom([{ slot: 'modal', mounted: true, childCount: 1, pattern: 'unknown-pattern' }])),
    ];
    expect(assertSlotShowsForeignTransitionRender(frames, expectations)).toEqual([]);
  });

  it('stays silent when the DOM carries no pattern marker at all (older driver, no data-pattern probe)', () => {
    const frames: Frame[] = [
      frame(0, cause('X', 'a', 'OPEN_A', 'b'), dom([{ slot: 'modal', mounted: true, childCount: 1 }])),
    ];
    expect(assertSlotShowsForeignTransitionRender(frames, expectations)).toEqual([]);
  });
});
