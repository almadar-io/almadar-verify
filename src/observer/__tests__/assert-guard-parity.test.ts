import { describe, it, expect } from 'vitest';
import type { VerificationSnapshot } from '@almadar/core';
import { assertGuardParity } from '../assert-guard-parity.js';
import type { Frame, FrameCause } from '../../frame/types.js';

const emptySnapshot: VerificationSnapshot = {
  checks: [],
  transitions: [],
  bridge: null,
  summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
  traits: [],
};

const cause = (
  trait: string,
  from: string,
  event: string,
  to: string,
  opts: {
    guardCase?: 'pass' | 'fail' | null;
    triggerKind?: FrameCause['triggerKind'];
    isRepositioning?: boolean;
  } = {},
): FrameCause => ({
  traitName: trait,
  from,
  event,
  to,
  guardCase: opts.guardCase ?? null,
  triggerKind: opts.triggerKind ?? 'bus',
  isRepositioning: opts.isRepositioning ?? false,
});

function frame(index: number, c: FrameCause, accepted: boolean): Frame {
  return {
    index,
    timestamp: 1000 + index,
    cause: c,
    stateBefore: c.from,
    stateAfter: accepted ? c.to : c.from,
    payload: {},
    eventFired: c.event,
    runtimeSnapshot: emptySnapshot,
    domSnapshot: { url: '', rowsByEntity: {}, portals: [], visibleTextSample: '' },
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

describe('assertGuardParity', () => {
  it('passes when every guard prediction matches the runtime', () => {
    // `accepted` already folds in the guardCase (decideAccepted): a 'pass'
    // frame is accepted iff it reached `to`; a 'fail' frame is accepted iff the
    // state correctly HELD. So a correctly-rejected guard-fail is accepted=true.
    const frames = [
      frame(0, cause('T', 'idle', 'OPEN', 'open', { guardCase: 'pass' }), true),
      frame(1, cause('T', 'idle', 'OPEN', 'idle', { guardCase: 'fail' }), true),
      // unguarded + auto-init + reposition frames are ignored.
      frame(2, cause('T', 'idle', 'TICK', 'idle', { guardCase: null }), false),
      frame(3, cause('T', 'idle', 'INIT', 'idle', { guardCase: 'pass', triggerKind: 'auto-init' }), false),
      frame(4, cause('T', 'idle', 'OPEN', 'idle', { guardCase: 'pass', isRepositioning: true }), false),
    ];
    const verdict = assertGuardParity(frames);
    expect(verdict.passed).toBe(true);
    expect(verdict.detail).toContain('2 guard prediction(s) matched');
  });

  it('fails when a guardCase:pass frame was not accepted (GUARD-LAMBDA-DROP)', () => {
    const frames = [
      frame(0, cause('T', 'idle', 'OPEN', 'open', { guardCase: 'pass' }), false),
      frame(1, cause('T', 'idle', 'OPEN', 'idle', { guardCase: 'fail' }), true), // correct rejection
    ];
    const verdict = assertGuardParity(frames);
    expect(verdict.passed).toBe(false);
    expect(verdict.detail).toContain('behaved unexpectedly');
    expect(verdict.evidence?.frameIndices).toEqual([0]);
  });

  it('fails when a guardCase:fail frame transitioned anyway (guard did not block)', () => {
    // accepted=false on a 'fail' frame = the state moved when the guard should
    // have held it → the compiled guard diverged.
    const frames = [
      frame(0, cause('T', 'idle', 'OPEN', 'open', { guardCase: 'fail' }), false),
    ];
    const verdict = assertGuardParity(frames);
    expect(verdict.passed).toBe(false);
    expect(verdict.evidence?.frameIndices).toEqual([0]);
  });
});
