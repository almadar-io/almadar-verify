import { describe, it, expect } from 'vitest';
import type { EventLogEntry, VerificationSnapshot } from '@almadar/core';
import { assertContractEventFired } from '../assert-contract-event-fired.js';
import type { Frame, FrameCause } from '../../frame/types.js';
import type { ConsoleEntry } from '../../util/types.js';

const emptyDom = { url: '', rowsByEntity: {}, portals: [], visibleTextSample: '' };
const emptySnapshot: VerificationSnapshot = {
  checks: [],
  transitions: [],
  bridge: null,
  summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
  traits: [],
};

const contractCause = (event: string): FrameCause => ({
  traitName: 'X',
  from: 'a',
  event,
  to: 'a',
  guardCase: null,
  triggerKind: 'dom',
  isRepositioning: false,
  testKind: 'contract',
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
  eventLogAdded: ReadonlyArray<EventLogEntry>,
  consoleAdded: ReadonlyArray<ConsoleEntry> = [],
): Frame {
  const newErrors = consoleAdded.filter((e) => e.type === 'error').length;
  const newWarnings = consoleAdded.filter((e) => e.type === 'warning').length;
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
    consoleDelta: { added: consoleAdded, newErrors, newWarnings },
    eventLogDelta: { added: eventLogAdded },
    entityChanges: [],
    effectResults: [],
    serverResponse: null,
    screenshotPath: null,
    accepted: true,
    errors: [],
    warnings: [],
  };
}

describe('assertContractEventFired', () => {
  it('returns [] when no frames have testKind: contract', () => {
    const frames: Frame[] = [
      frame(0, otherCause('INIT'), [{ type: 'INIT', timestamp: 1 }]),
      frame(1, otherCause('GO'), [{ type: 'GO', timestamp: 2 }]),
    ];
    expect(assertContractEventFired(frames)).toEqual([]);
  });

  it('passes when the contract event appears in eventLogDelta and no console errors fired', () => {
    const frames: Frame[] = [
      frame(0, contractCause('SELECT_ITEM'), [{ type: 'SELECT_ITEM', timestamp: 1 }]),
    ];
    const verdicts = assertContractEventFired(frames);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(true);
    expect(verdicts[0].detail).toMatch(/fired cleanly/);
  });

  it('fails when the contract event does NOT appear in eventLogDelta', () => {
    const frames: Frame[] = [
      // No event log entry for SELECT_ITEM
      frame(0, contractCause('SELECT_ITEM'), [{ type: 'OTHER_EVENT', timestamp: 1 }]),
    ];
    const verdicts = assertContractEventFired(frames);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/did not fire/);
  });

  it('fails when the event fires BUT a JS console error appears', () => {
    const frames: Frame[] = [
      frame(
        0,
        contractCause('SELECT_ITEM'),
        [{ type: 'SELECT_ITEM', timestamp: 1 }],
        [{ type: 'error', text: 'Cannot read properties of undefined', timestamp: 1 }],
      ),
    ];
    const verdicts = assertContractEventFired(frames);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/fired but produced 1 JS error/);
    expect(verdicts[0].detail).toMatch(/Cannot read properties/);
  });

  it('produces one verdict per contract frame', () => {
    const frames: Frame[] = [
      frame(0, contractCause('A'), [{ type: 'A', timestamp: 1 }]),
      frame(1, contractCause('B'), [{ type: 'B', timestamp: 2 }]),
      frame(2, contractCause('C'), [{ type: 'OTHER', timestamp: 3 }]),
    ];
    const verdicts = assertContractEventFired(frames);
    expect(verdicts).toHaveLength(3);
    expect(verdicts[0].passed).toBe(true);
    expect(verdicts[1].passed).toBe(true);
    expect(verdicts[2].passed).toBe(false);
  });
});
