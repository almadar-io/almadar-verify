import { describe, it, expect } from 'vitest';
import type { TraitStateSnapshot, VerificationSnapshot } from '@almadar/core';
import { assertClickPathSample } from '../assert-click-path-sample.js';
import type { Frame, FrameCause } from '../../frame/types.js';

const emptyDom = { url: '', rowsByEntity: {}, portals: [], visibleTextSample: '' };

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

function frame(
  index: number,
  cause: FrameCause,
  traits: ReadonlyArray<{ name: string; state: string }>,
  accepted = true,
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
    domSnapshot: emptyDom,
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

const clickPathCause = (traitName: string, event: string): FrameCause => ({
  traitName,
  from: 'a',
  event,
  to: 'a',
  guardCase: null,
  triggerKind: 'dom',
  isRepositioning: false,
  testKind: 'click-path',
});

const otherCause = (traitName: string, event: string): FrameCause => ({
  traitName,
  from: 'a',
  event,
  to: 'b',
  guardCase: null,
  triggerKind: 'bus',
  isRepositioning: false,
});

describe('assertClickPathSample', () => {
  it('returns [] when no frames have testKind: click-path', () => {
    const frames: Frame[] = [
      frame(0, otherCause('X', 'INIT'), [{ name: 'X', state: 'a' }]),
      frame(1, otherCause('X', 'GO'), [{ name: 'X', state: 'b' }]),
    ];
    expect(assertClickPathSample(frames)).toEqual([]);
  });

  it('passes when a click-path frame shows some trait state advanced from previous frame', () => {
    const frames: Frame[] = [
      frame(0, otherCause('X', 'INIT'), [{ name: 'X', state: 'a' }]),
      frame(1, clickPathCause('X', 'CLICK'), [{ name: 'X', state: 'b' }]),
    ];
    const verdicts = assertClickPathSample(frames);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(true);
    expect(verdicts[0].detail).toMatch(/advanced X's state/);
  });

  it('fails when the click-path frame is rejected (dispatch never reached the reducer)', () => {
    const frames: Frame[] = [
      frame(0, otherCause('X', 'INIT'), [{ name: 'X', state: 'a' }]),
      frame(1, clickPathCause('X', 'CLICK'), [{ name: 'X', state: 'a' }], false),
    ];
    const verdicts = assertClickPathSample(frames);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/dead event key/);
  });

  it('passes a self-loop click (accepted=true, state unchanged) — Refresh/Retry buttons wired to INIT', () => {
    const frames: Frame[] = [
      frame(0, otherCause('X', 'INIT'), [{ name: 'X', state: 'a' }]),
      frame(1, clickPathCause('X', 'INIT'), [{ name: 'X', state: 'a' }], true),
    ];
    const verdicts = assertClickPathSample(frames);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(true);
    expect(verdicts[0].detail).toMatch(/self-loop/);
  });

  it('passes when the click drives a CROSS-trait state change (legitimate handoff)', () => {
    // Trait X clicks ADD_ITEM, but trait Y (the modal) actually advances state.
    const frames: Frame[] = [
      frame(0, otherCause('X', 'INIT'), [
        { name: 'X', state: 'browsing' },
        { name: 'Y', state: 'closed' },
      ]),
      frame(1, clickPathCause('X', 'ADD_ITEM'), [
        { name: 'X', state: 'browsing' },
        { name: 'Y', state: 'form' },
      ]),
    ];
    const verdicts = assertClickPathSample(frames);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(true);
    expect(verdicts[0].detail).toMatch(/advanced Y's state/);
  });

  it('fails the first frame if it has testKind: click-path and no previous frame', () => {
    const frames: Frame[] = [
      frame(0, clickPathCause('X', 'CLICK'), [{ name: 'X', state: 'a' }]),
    ];
    const verdicts = assertClickPathSample(frames);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/no previous frame/);
  });

  it('produces one verdict per click-path frame in the stream', () => {
    const frames: Frame[] = [
      frame(0, otherCause('X', 'INIT'), [{ name: 'X', state: 'a' }]),
      frame(1, clickPathCause('X', 'CLICK_A'), [{ name: 'X', state: 'b' }]),
      frame(2, clickPathCause('X', 'CLICK_B'), [{ name: 'X', state: 'b' }], false), // dispatch rejected
    ];
    const verdicts = assertClickPathSample(frames);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0].passed).toBe(true);
    expect(verdicts[1].passed).toBe(false);
  });
});
