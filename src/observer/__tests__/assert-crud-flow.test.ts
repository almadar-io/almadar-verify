import { describe, it, expect } from 'vitest';
import type {
  EntityRow,
  ServerResponseTrace,
  TransitionTrace,
  VerificationSnapshot,
} from '@almadar/core';
import { assertCrudFlow } from '../assert-crud-flow.js';
import type { Frame, FrameCause, EntityChange } from '../../frame/types.js';

const emptySnapshot: VerificationSnapshot = {
  checks: [],
  transitions: [],
  bridge: null,
  summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
  traits: [],
};

/**
 * Build a snapshot whose `transitions[]` carries a single persistor
 * `TransitionTrace` with the given `serverResponse.emittedEvents`.
 * Mirrors the real shape: when a CRUD step's modal-trait frame settles,
 * the persistor's cascading transition lands in the same snapshot
 * carrying the persist's `emit.success` event.
 */
function snapshotWithCascadingPersistor(
  emittedEvents: ReadonlyArray<string>,
  traitName = 'TestPersistor',
  event = 'DO_UPDATE',
): VerificationSnapshot {
  const transition: TransitionTrace = {
    id: `tx-${traitName}-${event}`,
    traitName,
    from: 'idle',
    to: 'idle',
    event,
    effects: [],
    serverResponse: {
      orbitalName: traitName,
      success: true,
      clientEffects: 0,
      dataEntities: {},
      emittedEvents: [...emittedEvents],
      timestamp: 2000,
    },
    timestamp: 2000,
  };
  return {
    ...emptySnapshot,
    transitions: [transition],
  };
}

function dom(entityName: string, count: number): Frame['domSnapshot'] {
  return {
    url: '',
    rowsByEntity: { [entityName]: count },
    portals: [],
    visibleTextSample: '',
  };
}

function serverResponse(emittedEvents: ReadonlyArray<string>): ServerResponseTrace {
  return {
    orbitalName: 'TestOrbital',
    success: true,
    clientEffects: 0,
    dataEntities: {},
    emittedEvents: [...emittedEvents],
    timestamp: 1000,
  };
}

interface CrudCauseInput {
  testKind: 'crud-create' | 'crud-edit' | 'crud-delete';
  event: string;
  entityName: string;
  delta: number;
  expectedSuccessEvent: string;
  expectedRowContent?: Record<string, import('@almadar/core').FieldValue>;
  expectedRowChangedFields?: ReadonlyArray<string>;
  targetRowId?: string;
}

function crudCause(input: CrudCauseInput): FrameCause {
  return {
    traitName: 'TestModal',
    from: 'closed',
    event: input.event,
    to: 'closed',
    guardCase: null,
    triggerKind: 'dom',
    isRepositioning: false,
    testKind: input.testKind,
    expectedRowDelta: { entityName: input.entityName, delta: input.delta },
    expectedSuccessEvent: input.expectedSuccessEvent,
    ...(input.expectedRowContent !== undefined && { expectedRowContent: input.expectedRowContent }),
    ...(input.expectedRowChangedFields !== undefined && { expectedRowChangedFields: input.expectedRowChangedFields }),
    ...(input.targetRowId !== undefined && { targetRowId: input.targetRowId }),
  };
}

interface FrameInput {
  index: number;
  cause: FrameCause;
  entityChanges: ReadonlyArray<EntityChange>;
  domCount: number;
  emitted: ReadonlyArray<string>;
  /** Optional snapshot override. Defaults to `emptySnapshot`. Use
   *  `snapshotWithCascadingPersistor` to simulate a real CRUD flow
   *  where the persist response lands on a sibling transition. */
  snapshot?: VerificationSnapshot;
  /** Override the dom snapshot's entity key. Defaults to the cause's
   *  expectedRowDelta.entityName. Used when the frame's cause is NOT a
   *  CRUD step (e.g. a cascading Browse listener frame) but the dom
   *  must still report rows under the CRUD entity name. */
  domEntityName?: string;
}

function buildFrame(input: FrameInput): Frame {
  const entityName = input.domEntityName ?? input.cause.expectedRowDelta?.entityName ?? '';
  return {
    index: input.index,
    timestamp: 1000 + input.index,
    cause: input.cause,
    stateBefore: input.cause.from,
    stateAfter: input.cause.to,
    payload: {},
    eventFired: input.cause.event,
    runtimeSnapshot: input.snapshot ?? emptySnapshot,
    domSnapshot: dom(entityName, input.domCount),
    consoleDelta: { added: [], newErrors: 0, newWarnings: 0 },
    eventLogDelta: { added: [] },
    entityChanges: input.entityChanges,
    effectResults: [],
    serverResponse: input.emitted.length > 0 ? serverResponse(input.emitted) : null,
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

const updateChange = (
  entityName: string,
  before: EntityRow,
  after: EntityRow,
  fieldsChanged: ReadonlyArray<string>,
): EntityChange => ({
  entityName,
  before: [before],
  after: [after],
  added: [],
  removed: [],
  changed: [{ id: String(before.id), before, after, fieldsChanged }],
});

const deleteChange = (entityName: string, removedRows: ReadonlyArray<EntityRow>): EntityChange => ({
  entityName,
  before: removedRows,
  after: [],
  added: [],
  removed: removedRows,
  changed: [],
});

describe('assertCrudFlow', () => {
  it('returns [] when no frames carry a crud testKind', () => {
    const f = buildFrame({
      index: 0,
      cause: {
        traitName: 'X',
        from: 'a',
        event: 'GO',
        to: 'b',
        guardCase: null,
        triggerKind: 'bus',
        isRepositioning: false,
      },
      entityChanges: [],
      domCount: 0,
      emitted: [],
    });
    expect(assertCrudFlow([f])).toEqual([]);
  });

  it('crud-create passes when emit + content + dom delta all line up', () => {
    const cause = crudCause({
      testKind: 'crud-create',
      event: 'CREATE',
      entityName: 'ListItem',
      delta: 1,
      expectedSuccessEvent: 'ITEM_CREATED',
      expectedRowContent: { name: 'Verify Row', status: 'active' },
    });
    const f = buildFrame({
      index: 0,
      cause,
      entityChanges: [createChange('ListItem', [{ id: '1', name: 'Verify Row', status: 'active' }])],
      domCount: 1,
      emitted: ['ITEM_CREATED'],
    });
    const v = assertCrudFlow([f]);
    expect(v).toHaveLength(1);
    expect(v[0].passed).toBe(true);
    expect(v[0].detail).toMatch(/emit ✓/);
    expect(v[0].detail).toMatch(/diff ✓/);
    expect(v[0].detail).toMatch(/dom ✓/);
  });

  it('crud-create fails on emit-axis miss', () => {
    const cause = crudCause({
      testKind: 'crud-create',
      event: 'CREATE',
      entityName: 'ListItem',
      delta: 1,
      expectedSuccessEvent: 'ITEM_CREATED',
      expectedRowContent: { name: 'X' },
    });
    const f = buildFrame({
      index: 0,
      cause,
      entityChanges: [createChange('ListItem', [{ id: '1', name: 'X' }])],
      domCount: 1,
      emitted: [], // no emit
    });
    const v = assertCrudFlow([f]);
    expect(v[0].passed).toBe(false);
    expect(v[0].detail).toMatch(/emit ✗/);
  });

  it('crud-create fails on content-mismatch axis', () => {
    const cause = crudCause({
      testKind: 'crud-create',
      event: 'CREATE',
      entityName: 'ListItem',
      delta: 1,
      expectedSuccessEvent: 'ITEM_CREATED',
      expectedRowContent: { name: 'Expected', status: 'active' },
    });
    const f = buildFrame({
      index: 0,
      cause,
      entityChanges: [createChange('ListItem', [{ id: '1', name: 'Different', status: 'active' }])],
      domCount: 1,
      emitted: ['ITEM_CREATED'],
    });
    const v = assertCrudFlow([f]);
    expect(v[0].passed).toBe(false);
    expect(v[0].detail).toMatch(/diff ✗/);
    expect(v[0].detail).toMatch(/name/);
  });

  it('crud-create fails on dom-axis miss', () => {
    const cause = crudCause({
      testKind: 'crud-create',
      event: 'CREATE',
      entityName: 'ListItem',
      delta: 1,
      expectedSuccessEvent: 'ITEM_CREATED',
    });
    const f = buildFrame({
      index: 0,
      cause,
      entityChanges: [createChange('ListItem', [{ id: '1', name: 'X' }])],
      domCount: 0, // entity diff says +1 but dom didn't update
      emitted: ['ITEM_CREATED'],
    });
    const v = assertCrudFlow([f]);
    expect(v[0].passed).toBe(false);
    expect(v[0].detail).toMatch(/dom ✗/);
  });

  it('mock storage tier demotes diff/dom misses when the emit axis passes', () => {
    const cause = crudCause({
      testKind: 'crud-create',
      event: 'CREATE',
      entityName: 'ListItem',
      delta: 1,
      expectedSuccessEvent: 'ITEM_CREATED',
    });
    const f = buildFrame({
      index: 0,
      cause,
      entityChanges: [], // mock regenerated the collection — no observable diff
      domCount: 0,
      emitted: ['ITEM_CREATED'],
    });
    const v = assertCrudFlow([f], 'mock');
    expect(v).toHaveLength(1);
    expect(v[0].passed).toBe(true);
    expect(v[0].detail).toMatch(/demoted under mock storage tier/);
    // strict tier (default) still fails the same frame
    expect(assertCrudFlow([f])[0].passed).toBe(false);
  });

  it('mock storage tier still fails when the emit axis misses', () => {
    const cause = crudCause({
      testKind: 'crud-create',
      event: 'CREATE',
      entityName: 'ListItem',
      delta: 1,
      expectedSuccessEvent: 'ITEM_CREATED',
    });
    const f = buildFrame({
      index: 0,
      cause,
      entityChanges: [],
      domCount: 0,
      emitted: [],
    });
    const v = assertCrudFlow([f], 'mock');
    expect(v[0].passed).toBe(false);
    expect(v[0].detail).toMatch(/emit ✗/);
  });

  it('crud-edit passes when one row changed with matching fields + content', () => {
    const causeCreate = crudCause({
      testKind: 'crud-create',
      event: 'CREATE',
      entityName: 'ListItem',
      delta: 1,
      expectedSuccessEvent: 'ITEM_CREATED',
    });
    const f0 = buildFrame({
      index: 0,
      cause: causeCreate,
      entityChanges: [createChange('ListItem', [{ id: '1', name: 'Old', status: 'active' }])],
      domCount: 1,
      emitted: ['ITEM_CREATED'],
    });

    const causeEdit = crudCause({
      testKind: 'crud-edit',
      event: 'EDIT',
      entityName: 'ListItem',
      delta: 0,
      expectedSuccessEvent: 'ITEM_UPDATED',
      expectedRowContent: { name: 'New' },
      expectedRowChangedFields: ['name'],
    });
    const f1 = buildFrame({
      index: 1,
      cause: causeEdit,
      entityChanges: [updateChange(
        'ListItem',
        { id: '1', name: 'Old', status: 'active' },
        { id: '1', name: 'New', status: 'active' },
        ['name'],
      )],
      domCount: 1,
      emitted: ['ITEM_UPDATED'],
    });

    const verdicts = assertCrudFlow([f0, f1]);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0].passed).toBe(true);
    expect(verdicts[1].passed).toBe(true);
  });

  it('crud-edit fails when expectedRowChangedFields is not a subset', () => {
    const causeEdit = crudCause({
      testKind: 'crud-edit',
      event: 'EDIT',
      entityName: 'ListItem',
      delta: 0,
      expectedSuccessEvent: 'ITEM_UPDATED',
      expectedRowChangedFields: ['name', 'description'],
    });
    const f = buildFrame({
      index: 0,
      cause: causeEdit,
      entityChanges: [updateChange(
        'ListItem',
        { id: '1', name: 'Old' },
        { id: '1', name: 'New' },
        ['name'], // description NOT in fieldsChanged
      )],
      domCount: 1,
      emitted: ['ITEM_UPDATED'],
    });
    const v = assertCrudFlow([f]);
    expect(v[0].passed).toBe(false);
    expect(v[0].detail).toMatch(/missing description/);
  });

  it('crud-delete passes when 1 row removed and dom -1', () => {
    const causeCreate = crudCause({
      testKind: 'crud-create',
      event: 'CREATE',
      entityName: 'ListItem',
      delta: 1,
      expectedSuccessEvent: 'ITEM_CREATED',
    });
    const f0 = buildFrame({
      index: 0,
      cause: causeCreate,
      entityChanges: [createChange('ListItem', [{ id: '1', name: 'X' }])],
      domCount: 1,
      emitted: ['ITEM_CREATED'],
    });
    const causeDelete = crudCause({
      testKind: 'crud-delete',
      event: 'DELETE',
      entityName: 'ListItem',
      delta: -1,
      expectedSuccessEvent: 'ITEM_DELETED',
    });
    const f1 = buildFrame({
      index: 1,
      cause: causeDelete,
      entityChanges: [deleteChange('ListItem', [{ id: '1', name: 'X' }])],
      domCount: 0,
      emitted: ['ITEM_DELETED'],
    });
    const v = assertCrudFlow([f0, f1]);
    expect(v[1].passed).toBe(true);
  });

  it('crud-delete fails when targetRowId does not match removed row id', () => {
    const cause = crudCause({
      testKind: 'crud-delete',
      event: 'DELETE',
      entityName: 'ListItem',
      delta: -1,
      expectedSuccessEvent: 'ITEM_DELETED',
      targetRowId: '99',
    });
    const f = buildFrame({
      index: 0,
      cause,
      entityChanges: [deleteChange('ListItem', [{ id: '1', name: 'X' }])],
      domCount: 0,
      emitted: ['ITEM_DELETED'],
    });
    const v = assertCrudFlow([f]);
    expect(v[0].passed).toBe(false);
    expect(v[0].detail).toMatch(/removed row id mismatch/);
  });

  // The CRUD-step frame's own `serverResponse` carries the modal trait's
  // response (e.g. ListItemEdit for crud-edit). The persist op runs on a
  // separate cascading transition (e.g. ListItemPersistor.DO_UPDATE)
  // whose response carries the `emit.success` event. The assertCrudFlow
  // emit-axis check has to scan `runtimeSnapshot.transitions` for that
  // cascading response, not just the frame-local one.
  it('crud-edit emit-axis passes when success event is in a cascading persistor transition', () => {
    const beforeRow: EntityRow = {
      id: '1',
      name: 'Old',
      description: 'old',
      status: 'active',
    };
    const afterRow: EntityRow = {
      id: '1',
      name: 'New',
      description: 'new',
      status: 'active',
    };
    const cause = crudCause({
      testKind: 'crud-edit',
      event: 'EDIT',
      entityName: 'ListItem',
      delta: 0,
      expectedSuccessEvent: 'ITEM_UPDATED',
      expectedRowChangedFields: ['name', 'description'],
      expectedRowContent: { name: 'New', description: 'new' },
    });
    const prev = buildFrame({
      index: 0,
      cause: { ...cause, testKind: undefined } as unknown as FrameCause,
      entityChanges: [],
      domCount: 1,
      emitted: [],
    });
    const f = buildFrame({
      index: 1,
      cause,
      entityChanges: [updateChange('ListItem', beforeRow, afterRow, ['name', 'description'])],
      domCount: 1,
      // Modal-trait response — does NOT carry ITEM_UPDATED. Earlier
      // versions of assertCrudFlow stopped here and reported emit ✗.
      emitted: ['ListItemEditSaved'],
      // Cascading persistor transition — DOES carry ITEM_UPDATED.
      snapshot: snapshotWithCascadingPersistor(['ITEM_UPDATED']),
    });
    const v = assertCrudFlow([prev, f]);
    expect(v[0].passed).toBe(true);
    expect(v[0].detail).toMatch(/emit ✓ \(ITEM_UPDATED\)/);
  });

  it('crud-edit emit-axis fails when neither cascade nor frame.serverResponse carries the success event', () => {
    const beforeRow: EntityRow = { id: '1', name: 'Old' };
    const afterRow: EntityRow = { id: '1', name: 'New' };
    const cause = crudCause({
      testKind: 'crud-edit',
      event: 'EDIT',
      entityName: 'ListItem',
      delta: 0,
      expectedSuccessEvent: 'ITEM_UPDATED',
      expectedRowChangedFields: ['name'],
    });
    const prev = buildFrame({
      index: 0,
      cause: { ...cause, testKind: undefined } as unknown as FrameCause,
      entityChanges: [],
      domCount: 1,
      emitted: [],
    });
    const f = buildFrame({
      index: 1,
      cause,
      entityChanges: [updateChange('ListItem', beforeRow, afterRow, ['name'])],
      domCount: 1,
      emitted: ['SomethingElse'],
      // Snapshot has a persistor transition but it emits a different event.
      snapshot: snapshotWithCascadingPersistor(['ITEM_DRAFTED']),
    });
    const v = assertCrudFlow([prev, f]);
    expect(v[0].passed).toBe(false);
    expect(v[0].detail).toMatch(/emit ✗.*ITEM_UPDATED/);
  });

  it('crud-create emit-axis falls back to frame.serverResponse when snapshot has no matching transition', () => {
    const cause = crudCause({
      testKind: 'crud-create',
      event: 'CREATE',
      entityName: 'ListItem',
      delta: 1,
      expectedSuccessEvent: 'ITEM_CREATED',
    });
    const f = buildFrame({
      index: 0,
      cause,
      entityChanges: [createChange('ListItem', [{ id: 'new-1' }])],
      domCount: 1,
      // Frame's own response carries the event — non-cascading test
      // case where the modal IS the source of truth.
      emitted: ['ITEM_CREATED'],
      // Snapshot is empty: no cascading persistor transition.
      snapshot: emptySnapshot,
    });
    const v = assertCrudFlow([f]);
    expect(v[0].passed).toBe(true);
    expect(v[0].detail).toMatch(/emit ✓ \(ITEM_CREATED\)/);
  });

  // V-1 Path C: persist→emit→listen→fetch cascade may settle AFTER the
  // modal-trait step's snapshot is captured. The step frame's own
  // entityChanges then shows nothing; the cascading fetch's data
  // reduces into the Browse trait one frame later. Cascade-aware Axis 2
  // forward-scans subsequent frames (bounded by MAX_CASCADE_LOOKAHEAD
  // and stopping at the next CRUD step / reconcile) for the matching
  // EntityChange. The DOM count delta is then read off the same settled
  // frame so all three axes line up.
  it('crud-create cascade-aware: passes when entityChange + DOM land 2 frames later', () => {
    const baselinePrev = buildFrame({
      index: 0,
      cause: {
        traitName: 'X',
        from: 'init',
        event: 'INIT',
        to: 'browsing',
        guardCase: null,
        triggerKind: 'auto-init',
        isRepositioning: false,
      },
      entityChanges: [],
      domCount: 0,
      emitted: [],
      domEntityName: 'ListItem',
    });
    const crudCreateCause = crudCause({
      testKind: 'crud-create',
      event: 'CREATE',
      entityName: 'ListItem',
      delta: 1,
      expectedSuccessEvent: 'ITEM_CREATED',
      expectedRowContent: { name: 'New row' },
    });
    // Step frame: no entity change yet (persist in flight); emit lands
    // on cascading persistor transition though.
    const stepFrame = buildFrame({
      index: 1,
      cause: crudCreateCause,
      entityChanges: [],
      domCount: 0,
      emitted: ['ListItemEditSaved'],
      snapshot: snapshotWithCascadingPersistor(['ITEM_CREATED']),
    });
    // Intermediate frame: cascade still in flight.
    const intermediate = buildFrame({
      index: 2,
      cause: {
        traitName: 'ListItemBrowse',
        from: 'browsing',
        event: 'INIT',
        to: 'loading',
        guardCase: null,
        triggerKind: 'bus',
        isRepositioning: false,
      },
      entityChanges: [],
      domCount: 0,
      emitted: [],
      domEntityName: 'ListItem',
    });
    // Settled frame: cascading fetch landed, entityChange shows added row.
    const settled = buildFrame({
      index: 3,
      cause: {
        traitName: 'ListItemBrowse',
        from: 'loading',
        event: 'ListItemLoaded',
        to: 'browsing',
        guardCase: null,
        triggerKind: 'bus',
        isRepositioning: false,
      },
      entityChanges: [createChange('ListItem', [{ id: 'new-1', name: 'New row' }])],
      domCount: 1,
      emitted: [],
      domEntityName: 'ListItem',
    });
    const v = assertCrudFlow([baselinePrev, stepFrame, intermediate, settled]);
    expect(v).toHaveLength(1);
    expect(v[0].passed).toBe(true);
    expect(v[0].detail).toMatch(/emit ✓ \(ITEM_CREATED\)/);
    expect(v[0].detail).toMatch(/diff ✓/);
    expect(v[0].detail).toMatch(/dom ✓.*0→1/);
    expect(v[0].evidence?.frameIndices).toEqual([0, 1, 3]);
  });

  it('crud-edit cascade-aware: credits a row change settling 1 frame later', () => {
    const editCause = crudCause({
      testKind: 'crud-edit',
      event: 'EDIT',
      entityName: 'ListItem',
      delta: 0,
      expectedSuccessEvent: 'ITEM_UPDATED',
      expectedRowChangedFields: ['name'],
    });
    const baselinePrev = buildFrame({
      index: 0,
      cause: { ...editCause, testKind: undefined } as unknown as FrameCause,
      entityChanges: [],
      domCount: 1,
      emitted: [],
    });
    const stepFrame = buildFrame({
      index: 1,
      cause: editCause,
      // No change visible immediately; emit lives on the cascading persistor.
      entityChanges: [],
      domCount: 1,
      emitted: ['ListItemEditSaved'],
      snapshot: snapshotWithCascadingPersistor(['ITEM_UPDATED']),
    });
    const settled = buildFrame({
      index: 2,
      cause: {
        traitName: 'ListItemBrowse',
        from: 'loading',
        event: 'ListItemLoaded',
        to: 'browsing',
        guardCase: null,
        triggerKind: 'bus',
        isRepositioning: false,
      },
      entityChanges: [updateChange(
        'ListItem',
        { id: '1', name: 'Old' },
        { id: '1', name: 'New' },
        ['name'],
      )],
      domCount: 1,
      emitted: [],
      domEntityName: 'ListItem',
    });
    const v = assertCrudFlow([baselinePrev, stepFrame, settled]);
    expect(v).toHaveLength(1);
    expect(v[0].passed).toBe(true);
    expect(v[0].detail).toMatch(/diff ✓.*fields=name/);
  });

  it('crud-delete cascade-aware: credits a row removal settling later', () => {
    const deleteCause = crudCause({
      testKind: 'crud-delete',
      event: 'DELETE',
      entityName: 'ListItem',
      delta: -1,
      expectedSuccessEvent: 'ITEM_DELETED',
      targetRowId: '1',
    });
    const baselinePrev = buildFrame({
      index: 0,
      cause: { ...deleteCause, testKind: undefined } as unknown as FrameCause,
      entityChanges: [],
      domCount: 1,
      emitted: [],
    });
    const stepFrame = buildFrame({
      index: 1,
      cause: deleteCause,
      entityChanges: [],
      domCount: 1,
      emitted: [],
      snapshot: snapshotWithCascadingPersistor(['ITEM_DELETED']),
    });
    const settled = buildFrame({
      index: 2,
      cause: {
        traitName: 'ListItemBrowse',
        from: 'loading',
        event: 'ListItemLoaded',
        to: 'browsing',
        guardCase: null,
        triggerKind: 'bus',
        isRepositioning: false,
      },
      entityChanges: [deleteChange('ListItem', [{ id: '1', name: 'X' }])],
      domCount: 0,
      emitted: [],
      domEntityName: 'ListItem',
    });
    const v = assertCrudFlow([baselinePrev, stepFrame, settled]);
    expect(v[0].passed).toBe(true);
    expect(v[0].detail).toMatch(/diff ✓/);
    expect(v[0].detail).toMatch(/dom ✓.*1→0/);
  });

  it('cascade-aware scan stops at the next CRUD step boundary (no over-credit)', () => {
    const createA = crudCause({
      testKind: 'crud-create',
      event: 'CREATE_A',
      entityName: 'ListItem',
      delta: 1,
      expectedSuccessEvent: 'A_CREATED',
    });
    const createB = crudCause({
      testKind: 'crud-create',
      event: 'CREATE_B',
      entityName: 'ListItem',
      delta: 1,
      expectedSuccessEvent: 'B_CREATED',
    });
    const baseline = buildFrame({
      index: 0,
      cause: { ...createA, testKind: undefined } as unknown as FrameCause,
      entityChanges: [],
      domCount: 0,
      emitted: [],
    });
    // Step A: emit lands on cascade but no entity change in this frame.
    const stepA = buildFrame({
      index: 1,
      cause: createA,
      entityChanges: [],
      domCount: 0,
      emitted: [],
      snapshot: snapshotWithCascadingPersistor(['A_CREATED']),
    });
    // Step B starts before A's cascade settles. The scan must stop at B
    // — its entityChange belongs to step B, not step A.
    const stepB = buildFrame({
      index: 2,
      cause: createB,
      entityChanges: [createChange('ListItem', [{ id: 'b-1' }])],
      domCount: 1,
      emitted: ['B_CREATED'],
      snapshot: snapshotWithCascadingPersistor(['B_CREATED']),
    });
    const v = assertCrudFlow([baseline, stepA, stepB]);
    expect(v).toHaveLength(2);
    // Step A's diff axis must fail — its cascade never settled before
    // the boundary of step B.
    expect(v[0].passed).toBe(false);
    expect(v[0].detail).toMatch(/CREATE_A.*diff ✗/);
    // Step B passes on its own (immediate-frame entityChange).
    expect(v[1].passed).toBe(true);
  });

  it('cascade-aware scan stops at reconcile preamble (next-step boundary)', () => {
    const createCause = crudCause({
      testKind: 'crud-create',
      event: 'CREATE',
      entityName: 'ListItem',
      delta: 1,
      expectedSuccessEvent: 'ITEM_CREATED',
    });
    const baseline = buildFrame({
      index: 0,
      cause: { ...createCause, testKind: undefined } as unknown as FrameCause,
      entityChanges: [],
      domCount: 0,
      emitted: [],
    });
    const stepFrame = buildFrame({
      index: 1,
      cause: createCause,
      entityChanges: [],
      domCount: 0,
      emitted: [],
      snapshot: snapshotWithCascadingPersistor(['ITEM_CREATED']),
    });
    // Reconcile preamble for the next step — kernel reset before
    // walking to next-step.from. The entityChange here belongs to the
    // RESET, not to the cascade, and must NOT be credited.
    const reconcile = buildFrame({
      index: 2,
      cause: {
        traitName: 'X',
        from: 'init',
        event: 'RESET',
        to: 'init',
        guardCase: null,
        triggerKind: 'reconcile',
        isRepositioning: true,
      },
      entityChanges: [createChange('ListItem', [{ id: 'seeded-1' }])],
      domCount: 1,
      emitted: [],
    });
    const v = assertCrudFlow([baseline, stepFrame, reconcile]);
    expect(v[0].passed).toBe(false);
    expect(v[0].detail).toMatch(/diff ✗/);
  });

  it('cascade-aware scan respects MAX_CASCADE_LOOKAHEAD (no infinite forward search)', () => {
    const createCause = crudCause({
      testKind: 'crud-create',
      event: 'CREATE',
      entityName: 'ListItem',
      delta: 1,
      expectedSuccessEvent: 'ITEM_CREATED',
    });
    const baseline = buildFrame({
      index: 0,
      cause: { ...createCause, testKind: undefined } as unknown as FrameCause,
      entityChanges: [],
      domCount: 0,
      emitted: [],
    });
    const step = buildFrame({
      index: 1,
      cause: createCause,
      entityChanges: [],
      domCount: 0,
      emitted: ['ITEM_CREATED'],
    });
    // 5 follow-up frames all with no entityChange — past the window.
    // Then one with the entityChange — should NOT be credited.
    const farFrames: Frame[] = [];
    for (let k = 0; k < 5; k++) {
      farFrames.push(buildFrame({
        index: 2 + k,
        cause: {
          traitName: 'X',
          from: 's',
          event: 'TICK',
          to: 's',
          guardCase: null,
          triggerKind: 'bus',
          isRepositioning: false,
        },
        entityChanges: [],
        domCount: 0,
        emitted: [],
      }));
    }
    const beyondWindow = buildFrame({
      index: 7,
      cause: {
        traitName: 'X',
        from: 's',
        event: 'TICK',
        to: 's',
        guardCase: null,
        triggerKind: 'bus',
        isRepositioning: false,
      },
      entityChanges: [createChange('ListItem', [{ id: 'late-1' }])],
      domCount: 1,
      emitted: [],
    });
    const v = assertCrudFlow([baseline, step, ...farFrames, beyondWindow]);
    expect(v[0].passed).toBe(false);
    expect(v[0].detail).toMatch(/diff ✗/);
  });

  it('fails when expectedSuccessEvent is missing on the cause (planner bug)', () => {
    const cause: FrameCause = {
      traitName: 'TestModal',
      from: 'closed',
      event: 'CREATE',
      to: 'closed',
      guardCase: null,
      triggerKind: 'dom',
      isRepositioning: false,
      testKind: 'crud-create',
      expectedRowDelta: { entityName: 'ListItem', delta: 1 },
      // no expectedSuccessEvent
    };
    const f = buildFrame({
      index: 0,
      cause,
      entityChanges: [createChange('ListItem', [{ id: '1' }])],
      domCount: 1,
      emitted: ['X'],
    });
    const v = assertCrudFlow([f]);
    expect(v[0].passed).toBe(false);
    expect(v[0].detail).toMatch(/planner bug/);
  });
});
