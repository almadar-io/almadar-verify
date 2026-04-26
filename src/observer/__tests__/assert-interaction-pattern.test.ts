import { describe, it, expect } from 'vitest';
import type { TraitStateSnapshot, VerificationSnapshot } from '@almadar/core';
import { assertInteractionPattern } from '../assert-interaction-pattern.js';
import type { DomSnapshot, Frame, FrameCause } from '../../frame/types.js';
import type { PortalSlot } from '../../browser/portal-slots.js';

function snapshot(traits: ReadonlyArray<{ name: string; state: string }>): VerificationSnapshot {
  const traitSnapshots: TraitStateSnapshot[] = traits.map((t) => ({
    traitName: t.name,
    currentState: t.state,
    states: ['a', 'b'],
    events: ['GO'],
    data: {},
    cascadeReceived: [],
  }));
  return {
    checks: [],
    transitions: [],
    bridge: null,
    summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
    traits: traitSnapshots,
  };
}

function dom(portals: ReadonlyArray<{ slot: PortalSlot; mounted: boolean; childCount: number }>): DomSnapshot {
  return { url: '', rowsByEntity: {}, portals, visibleTextSample: '' };
}

const interactionCause = (
  event: string,
  expected?: string,
  guardCase?: 'pass' | 'fail' | null,
): FrameCause => ({
  traitName: 'X',
  from: 'a',
  event,
  to: 'b',
  guardCase: guardCase ?? null,
  triggerKind: 'dom',
  isRepositioning: false,
  testKind: 'interaction',
  ...(expected !== undefined && { expectedPattern: expected }),
});

const otherCause = (event: string): FrameCause => ({
  traitName: 'X',
  from: 'a',
  event,
  to: 'b',
  guardCase: null,
  triggerKind: 'bus',
  isRepositioning: false,
});

function frame(
  index: number,
  cause: FrameCause,
  domSnapshot: DomSnapshot,
  traits: ReadonlyArray<{ name: string; state: string }> = [{ name: 'X', state: 'a' }],
): Frame {
  return {
    index,
    timestamp: 1000 + index,
    cause,
    stateBefore: cause.from,
    stateAfter: cause.to,
    payload: {},
    eventFired: cause.event,
    runtimeSnapshot: snapshot(traits),
    domSnapshot,
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

describe('assertInteractionPattern', () => {
  it('returns [] when no frames have testKind: interaction', () => {
    expect(assertInteractionPattern([
      frame(0, otherCause('INIT'), dom([])),
    ])).toEqual([]);
  });

  it('passes when expected pattern is set and a portal is mounted with content', () => {
    const frames: Frame[] = [
      frame(0, otherCause('INIT'), dom([])),
      frame(1, interactionCause('ADD_ITEM', 'modal'), dom([{ slot: 'modal', mounted: true, childCount: 2 }])),
    ];
    const verdicts = assertInteractionPattern(frames);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(true);
    expect(verdicts[0].detail).toMatch(/mounted "modal" pattern/);
  });

  it('passes via state-advance fallback when no portal mounted (cross-trait handoff)', () => {
    const frames: Frame[] = [
      frame(0, otherCause('INIT'), dom([]), [{ name: 'X', state: 'a' }, { name: 'Y', state: 'closed' }]),
      frame(1, interactionCause('ADD_ITEM', 'modal'), dom([]), [{ name: 'X', state: 'a' }, { name: 'Y', state: 'form' }]),
    ];
    const verdicts = assertInteractionPattern(frames);
    expect(verdicts[0].passed).toBe(true);
    expect(verdicts[0].detail).toMatch(/cross-trait handoff is legit/);
  });

  it('fails when no portal mounted AND no trait advanced', () => {
    const frames: Frame[] = [
      frame(0, otherCause('INIT'), dom([])),
      frame(1, interactionCause('ADD_ITEM', 'modal'), dom([])),
    ];
    const verdicts = assertInteractionPattern(frames);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/expected "modal" but no portal mounted/);
  });

  it('passes a guard-fail interaction when no new portal appears', () => {
    const frames: Frame[] = [
      frame(0, otherCause('INIT'), dom([])),
      frame(1, interactionCause('SAVE', 'form-section', 'fail'), dom([])),
    ];
    const verdicts = assertInteractionPattern(frames);
    expect(verdicts[0].passed).toBe(true);
    expect(verdicts[0].detail).toMatch(/guard-fail held/);
  });

  it('fails a guard-fail interaction when a portal appears anyway (guard breached)', () => {
    const frames: Frame[] = [
      frame(0, otherCause('INIT'), dom([])),
      frame(1, interactionCause('SAVE', 'form-section', 'fail'), dom([{ slot: 'modal', mounted: true, childCount: 1 }])),
    ];
    const verdicts = assertInteractionPattern(frames);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/guard-fail breached/);
  });

  it('produces one verdict per interaction frame', () => {
    const frames: Frame[] = [
      frame(0, otherCause('INIT'), dom([])),
      frame(1, interactionCause('A', 'modal'), dom([{ slot: 'modal', mounted: true, childCount: 1 }])),
      frame(2, interactionCause('B', 'modal'), dom([])),
    ];
    const verdicts = assertInteractionPattern(frames);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0].passed).toBe(true);
    expect(verdicts[1].passed).toBe(false);
  });
});
