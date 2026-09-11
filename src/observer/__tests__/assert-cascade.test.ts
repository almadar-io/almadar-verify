import { describe, it, expect } from 'vitest';
import { assertBusItemCascadedNTimes } from '../assert-cascade.js';
import type { Frame, FrameCause } from '../../frame/types.js';
import type { EventPayload, TraitStateSnapshot } from '@almadar/core';

const cause: FrameCause = {
  traitName: 'X', from: 'idle', event: 'GO', to: 'idle', guardCase: null, triggerKind: 'bus', isRepositioning: false,
};

function traitSnapshot(traitName: string, cascadeReceived: Array<{ event: string; payload?: EventPayload }>): TraitStateSnapshot {
  return {
    traitName, currentState: 'idle', states: ['idle'], events: [], data: {},
    cascadeReceived: cascadeReceived.map((c) => ({ ...c, timestamp: Date.now() })),
  };
}

function frame(index: number, traits: TraitStateSnapshot[]): Frame {
  return {
    index,
    timestamp: 1000 + index,
    cause,
    stateBefore: 'idle',
    stateAfter: 'idle',
    payload: {},
    eventFired: 'GO',
    runtimeSnapshot: { checks: [], bridge: null, summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 }, traits, transitions: [] },
    domSnapshot: { url: '', rowsByEntity: {}, portals: [], visibleTextSample: '' },
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

describe('assertBusItemCascadedNTimes', () => {
  it('returns [] when no trait received more than one of the same item', () => {
    const frames = [frame(0, [traitSnapshot('Listener', [{ event: 'A' }, { event: 'B' }])])];
    expect(assertBusItemCascadedNTimes(frames)).toEqual([]);
  });

  it('flags the SAME (event, payload) pair landing twice in one dispatch window', () => {
    const frames = [frame(0, [traitSnapshot('Listener', [{ event: 'A', payload: { id: 1 } }, { event: 'A', payload: { id: 1 } }])])];
    const verdicts = assertBusItemCascadedNTimes(frames);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/bus-item-cascaded-n-times: Listener received the SAME bus item \('A'\) 2 times/);
  });

  it('stays silent when the same event name fires twice with DIFFERENT payloads (a legitimate repeat, not a duplicate)', () => {
    const frames = [frame(0, [traitSnapshot('Listener', [{ event: 'A', payload: { id: 1 } }, { event: 'A', payload: { id: 2 } }])])];
    expect(assertBusItemCascadedNTimes(frames)).toEqual([]);
  });
});
