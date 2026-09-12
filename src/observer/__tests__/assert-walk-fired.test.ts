import { describe, it, expect } from 'vitest';
import type { VerificationSnapshot } from '@almadar/core';
import { assertWalkStepsFired } from '../assert-walk-fired.js';
import type { Frame, FrameCause } from '../../frame/types.js';

const emptySnapshot: VerificationSnapshot = {
  checks: [],
  transitions: [],
  bridge: null,
  summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
  traits: [],
};

function frame(index: number, cause: Partial<FrameCause>, accepted: boolean, transitioned?: boolean): Frame {
  const fullCause: FrameCause = {
    traitName: 'ChatComposer',
    from: 'ready',
    event: 'SEND',
    to: 'ready',
    guardCase: 'pass',
    payloadCase: 'success',
    triggerKind: 'bus',
    isRepositioning: false,
    coverageKey: 'ChatComposer:ready+SEND->ready[pass]',
    ...cause,
  };
  return {
    index,
    timestamp: 1000 + index,
    cause: fullCause,
    stateBefore: fullCause.from,
    stateAfter: fullCause.to,
    payload: {},
    eventFired: fullCause.event,
    runtimeSnapshot: emptySnapshot,
    domSnapshot: { url: '', rowsByEntity: {}, portals: [], visibleTextSample: '' },
    consoleDelta: { added: [], newErrors: 0, newWarnings: 0 },
    eventLogDelta: { added: [] },
    entityChanges: [],
    effectResults: [],
    serverResponse: transitioned === undefined
      ? null
      : { orbitalName: 'ChatMessageOrbital', success: true, transitioned, clientEffects: 0, dataEntities: {}, emittedEvents: [], timestamp: 1 },
    screenshotPath: null,
    accepted,
    errors: [],
    warnings: [],
  };
}

describe('assertWalkStepsFired', () => {
  it('fails a planned self-loop dispatch the runtime rejected — the chat composer SEND shape', () => {
    const verdict = assertWalkStepsFired([frame(0, {}, false, false)]);
    expect(verdict.passed).toBe(false);
    expect(verdict.detail).toContain('transition-not-fired: ChatComposer.SEND');
    expect(verdict.detail).toContain('no arm accepted it');
    expect(verdict.evidence?.frameIndices).toEqual([0]);
  });

  it('passes when every planned dispatch was accepted', () => {
    const verdict = assertWalkStepsFired([frame(0, {}, true, true), frame(1, { event: 'DRAFT_CHANGED', guardCase: null }, true, true)]);
    expect(verdict.passed).toBe(true);
    expect(verdict.detail).toContain('2 planned dispatch(es) fired');
  });

  it('leaves guard-fail, malformed, repositioning, errored, lifecycle and effect-emitted frames to their own observers', () => {
    const frames: Frame[] = [
      frame(0, { guardCase: 'fail', payloadCase: 'guard-fail' }, false, false),
      frame(1, { guardCase: null, payloadCase: 'malformed' }, false, false),
      frame(2, { triggerKind: 'replay', isRepositioning: true }, false, false),
      { ...frame(3, {}, false, false), errors: ['stateless dispatch'] },
      frame(4, { event: 'ChatMessageLoaded', guardCase: null, payloadCase: undefined, coverageKey: 'X:loading+ChatMessageLoaded->loading[emit]' }, false, false),
      frame(5, { testKind: 'data-mutation' }, false, false),
      frame(6, { event: 'INIT', guardCase: null, from: 'browsing', to: 'loading' }, false, false),
      frame(7, { event: 'ChatMessageLoaded', guardCase: null, from: 'loading', to: 'browsing' }, false, false),
    ];
    const verdict = assertWalkStepsFired(frames, new Map([['ChatComposer', new Set(['ChatMessageLoaded'])]]));
    expect(verdict.passed).toBe(true);
    expect(verdict.detail).toContain('0 planned dispatch(es)');
  });
});
