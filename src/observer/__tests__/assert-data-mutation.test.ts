import { describe, it, expect } from 'vitest';
import type { EntityRow, VerificationSnapshot } from '@almadar/core';
import { assertDataMutation } from '../assert-data-mutation.js';
import type { Frame, FrameCause, EntityChange } from '../../frame/types.js';

const emptyDom = { url: '', rowsByEntity: {}, portals: [], visibleTextSample: '' };
const emptySnapshot: VerificationSnapshot = {
  checks: [],
  transitions: [],
  bridge: null,
  summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
  traits: [],
};

const dataMutationCause = (
  event: string,
  expected?: { entityName: string; delta: number },
): FrameCause => ({
  traitName: 'CartItemAddItem',
  from: 'idle',
  event,
  to: 'idle',
  guardCase: null,
  triggerKind: 'dom',
  isRepositioning: false,
  testKind: 'data-mutation',
  ...(expected !== undefined && { expectedRowDelta: expected }),
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
  entityChanges: ReadonlyArray<EntityChange>,
): Frame {
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
    entityChanges,
    effectResults: [],
    serverResponse: null,
    screenshotPath: null,
    accepted: true,
    errors: [],
    warnings: [],
  };
}

const createChange = (entityName: string, addedRows: ReadonlyArray<EntityRow>): EntityChange => ({
  entityName,
  before: [],
  after: addedRows,
  added: addedRows,
  removed: [],
  changed: [],
});

const deleteChange = (entityName: string, removedRows: ReadonlyArray<EntityRow>): EntityChange => ({
  entityName,
  before: removedRows,
  after: [],
  added: [],
  removed: removedRows,
  changed: [],
});

describe('assertDataMutation', () => {
  it('returns [] when no frames have testKind: data-mutation', () => {
    const frames: Frame[] = [
      frame(0, otherCause('INIT'), []),
      frame(1, otherCause('GO'), []),
    ];
    expect(assertDataMutation(frames)).toEqual([]);
  });

  it('passes when create test sees +1 added row for the named entity', () => {
    const frames: Frame[] = [
      frame(
        0,
        dataMutationCause('SAVE', { entityName: 'CartItem', delta: 1 }),
        [createChange('CartItem', [{ id: '1', name: 'Apple' }])],
      ),
    ];
    const verdicts = assertDataMutation(frames);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(true);
    expect(verdicts[0].detail).toMatch(/delta = \+1 as expected/);
  });

  it('passes when delete test sees -1 row for the named entity', () => {
    const frames: Frame[] = [
      frame(
        0,
        dataMutationCause('CONFIRM_DELETE', { entityName: 'CartItem', delta: -1 }),
        [deleteChange('CartItem', [{ id: '1', name: 'Apple' }])],
      ),
    ];
    const verdicts = assertDataMutation(frames);
    expect(verdicts[0].passed).toBe(true);
  });

  it('fails when count delta is wrong', () => {
    const frames: Frame[] = [
      frame(
        0,
        dataMutationCause('SAVE', { entityName: 'CartItem', delta: 1 }),
        [createChange('CartItem', [])], // expected +1, got 0
      ),
    ];
    const verdicts = assertDataMutation(frames);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/expected delta \+1, got 0/);
  });

  it('fails when no entity change recorded for the named entity', () => {
    const frames: Frame[] = [
      frame(
        0,
        dataMutationCause('SAVE', { entityName: 'CartItem', delta: 1 }),
        [],
      ),
    ];
    const verdicts = assertDataMutation(frames);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/no entityChange recorded/);
  });

  it('fails when expectedRowDelta is missing on the cause (planner bug)', () => {
    const frames: Frame[] = [
      frame(0, dataMutationCause('SAVE'), [createChange('CartItem', [{ id: '1' }])]),
    ];
    const verdicts = assertDataMutation(frames);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/no expectedRowDelta on cause — planner bug/);
  });

  it('produces one verdict per data-mutation frame', () => {
    const frames: Frame[] = [
      frame(0, dataMutationCause('A', { entityName: 'X', delta: 1 }), [createChange('X', [{ id: '1' }])]),
      frame(1, dataMutationCause('B', { entityName: 'X', delta: 1 }), [createChange('X', [])]),
      frame(2, dataMutationCause('C', { entityName: 'X', delta: -1 }), [deleteChange('X', [{ id: '1' }])]),
    ];
    const verdicts = assertDataMutation(frames);
    expect(verdicts).toHaveLength(3);
    expect(verdicts[0].passed).toBe(true);
    expect(verdicts[1].passed).toBe(false);
    expect(verdicts[2].passed).toBe(true);
  });
});
