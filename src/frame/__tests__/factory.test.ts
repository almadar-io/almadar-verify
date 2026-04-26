/**
 * Tests for frame factory + temporal diff helpers.
 *
 * These functions are pure and the centerpiece of the temporal model;
 * regressions here cascade into every observer.
 */

import { describe, it, expect } from 'vitest';
import type { EntityData, EntityRow, EventLogEntry, VerificationSnapshot } from '@almadar/core';
import type { ConsoleEntry } from '../../util/types.js';
import {
  diffConsole,
  diffEntities,
  diffEventLog,
  keyOf,
  makeInitFrame,
  makeWalkFrame,
} from '../factory.js';
import type { FrameCause } from '../types.js';

const emptySnapshot: VerificationSnapshot = {
  checks: [],
  transitions: [],
  bridge: null,
  summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
  traits: [],
};

const emptyDomSnapshot = {
  url: 'http://localhost:3001',
  rowsByEntity: {},
  portals: [],
  visibleTextSample: '',
};

describe('keyOf', () => {
  it('builds the canonical coverage key for an unguarded transition', () => {
    const cause: FrameCause = {
      traitName: 'BrowseItemBrowse',
      from: 'loading',
      event: 'BrowseItemLoaded',
      to: 'browsing',
      guardCase: null,
      triggerKind: 'bus',
      isRepositioning: false,
    };
    expect(keyOf(cause)).toBe(
      'BrowseItemBrowse:loading+BrowseItemLoaded->browsing',
    );
  });

  it('appends [pass] for a guard-pass case', () => {
    const cause: FrameCause = {
      traitName: 'X',
      from: 'a',
      event: 'E',
      to: 'b',
      guardCase: 'pass',
      triggerKind: 'bus',
      isRepositioning: false,
    };
    expect(keyOf(cause)).toBe('X:a+E->b[pass]');
  });

  it('appends [fail] for a guard-fail case', () => {
    const cause: FrameCause = {
      traitName: 'X',
      from: 'a',
      event: 'E',
      to: 'b',
      guardCase: 'fail',
      triggerKind: 'bus',
      isRepositioning: false,
    };
    expect(keyOf(cause)).toBe('X:a+E->b[fail]');
  });
});

describe('diffConsole', () => {
  it('counts errors and warnings in the new tail', () => {
    const added: ConsoleEntry[] = [
      { type: 'error', text: 'boom', timestamp: 1 },
      { type: 'warning', text: 'soft', timestamp: 2 },
      { type: 'info', text: 'fyi', timestamp: 3 },
      { type: 'error', text: 'boom2', timestamp: 4 },
    ];
    const result = diffConsole(added);
    expect(result.added).toHaveLength(4);
    expect(result.newErrors).toBe(2);
    expect(result.newWarnings).toBe(1);
  });

  it('handles empty input', () => {
    const result = diffConsole([]);
    expect(result.added).toHaveLength(0);
    expect(result.newErrors).toBe(0);
    expect(result.newWarnings).toBe(0);
  });
});

describe('diffEventLog', () => {
  it('passes through the added entries unchanged', () => {
    const added: EventLogEntry[] = [
      { type: 'BrowseItemLoaded', timestamp: 1 },
      { type: 'BrowseItemLoadFailed', timestamp: 2 },
    ];
    expect(diffEventLog(added).added).toBe(added);
  });
});

describe('diffEntities', () => {
  it('detects added rows', () => {
    const before: EntityData = { CartItem: [] };
    const after: EntityData = {
      CartItem: [{ id: '1', name: 'Apple' }],
    };
    const result = diffEntities(before, after);
    expect(result).toHaveLength(1);
    expect(result[0].entityName).toBe('CartItem');
    expect(result[0].added).toHaveLength(1);
    expect(result[0].added[0].id).toBe('1');
    expect(result[0].removed).toHaveLength(0);
    expect(result[0].changed).toHaveLength(0);
  });

  it('detects removed rows', () => {
    const before: EntityData = {
      CartItem: [{ id: '1', name: 'Apple' }],
    };
    const after: EntityData = { CartItem: [] };
    const result = diffEntities(before, after);
    expect(result[0].removed).toHaveLength(1);
    expect(result[0].removed[0].id).toBe('1');
    expect(result[0].added).toHaveLength(0);
  });

  it('detects field changes on rows present in both sides', () => {
    const before: EntityData = {
      CartItem: [{ id: '1', name: 'Apple', qty: 1 }],
    };
    const after: EntityData = {
      CartItem: [{ id: '1', name: 'Apple', qty: 5 }],
    };
    const result = diffEntities(before, after);
    expect(result[0].added).toHaveLength(0);
    expect(result[0].removed).toHaveLength(0);
    expect(result[0].changed).toHaveLength(1);
    expect(result[0].changed[0].id).toBe('1');
    expect(result[0].changed[0].fieldsChanged).toEqual(['qty']);
  });

  it('treats Date fields by getTime equality', () => {
    const t1 = new Date('2026-01-01');
    const t2 = new Date('2026-01-01');
    const t3 = new Date('2026-02-02');
    const before: EntityData = { Order: [{ id: '1', createdAt: t1 }] };
    const sameTime: EntityData = { Order: [{ id: '1', createdAt: t2 }] };
    const diffTime: EntityData = { Order: [{ id: '1', createdAt: t3 }] };
    expect(diffEntities(before, sameTime)[0].changed).toHaveLength(0);
    expect(diffEntities(before, diffTime)[0].changed).toHaveLength(1);
  });

  it('handles arrays of FieldValue recursively', () => {
    const before: EntityData = {
      Cart: [{ id: '1', tags: ['a', 'b'] }],
    };
    const sameArr: EntityData = {
      Cart: [{ id: '1', tags: ['a', 'b'] }],
    };
    const diffArr: EntityData = {
      Cart: [{ id: '1', tags: ['a', 'b', 'c'] }],
    };
    expect(diffEntities(before, sameArr)[0].changed).toHaveLength(0);
    expect(diffEntities(before, diffArr)[0].changed).toHaveLength(1);
  });

  it('skips rows without an id from add/remove diffing but still includes the entity', () => {
    const before: EntityData = { Singleton: [{ name: 'a' } as EntityRow] };
    const after: EntityData = { Singleton: [{ name: 'b' } as EntityRow] };
    const result = diffEntities(before, after);
    expect(result).toHaveLength(1);
    expect(result[0].added).toHaveLength(0);
    expect(result[0].removed).toHaveLength(0);
    // No id → not in `changed` either (no stable identity to pair them).
    expect(result[0].changed).toHaveLength(0);
    // But `before`/`after` still carry the rows.
    expect(result[0].before).toHaveLength(1);
    expect(result[0].after).toHaveLength(1);
  });

  it('returns an entry per entity even when one side is missing', () => {
    const before: EntityData = { OnlyBefore: [{ id: '1' }] };
    const after: EntityData = { OnlyAfter: [{ id: '2' }] };
    const result = diffEntities(before, after);
    const names = result.map((c) => c.entityName).sort();
    expect(names).toEqual(['OnlyAfter', 'OnlyBefore']);
  });
});

describe('makeWalkFrame', () => {
  it('produces a frame whose deltas reflect the inputs', () => {
    const cause: FrameCause = {
      traitName: 'BrowseItemBrowse',
      from: 'loading',
      event: 'BrowseItemLoaded',
      to: 'browsing',
      guardCase: null,
      triggerKind: 'bus',
      isRepositioning: false,
    };
    const frame = makeWalkFrame({
      index: 1,
      timestamp: 1000,
      cause,
      stateBefore: 'loading',
      stateAfter: 'browsing',
      payload: { data: [] },
      runtimeSnapshot: emptySnapshot,
      domSnapshot: emptyDomSnapshot,
      consoleAdded: [{ type: 'error', text: 'oops', timestamp: 999 }],
      eventLogAdded: [{ type: 'BrowseItemLoaded', timestamp: 999 }],
      entitiesBefore: { BrowseItem: [] },
      entitiesAfter: { BrowseItem: [{ id: '1', name: 'A' }] },
      effectResults: [],
      serverResponse: null,
      screenshotPath: null,
      accepted: true,
    });

    expect(frame.index).toBe(1);
    expect(frame.eventFired).toBe('BrowseItemLoaded');
    expect(frame.consoleDelta.newErrors).toBe(1);
    expect(frame.eventLogDelta.added).toHaveLength(1);
    expect(frame.entityChanges).toHaveLength(1);
    expect(frame.entityChanges[0].added).toHaveLength(1);
    expect(frame.accepted).toBe(true);
  });
});

describe('makeInitFrame', () => {
  it('synthesizes the boot-INIT credit with auto-init triggerKind', () => {
    const frame = makeInitFrame({
      index: 0,
      timestamp: 500,
      traitName: 'BrowseItemBrowse',
      initialState: 'loading',
      runtimeSnapshot: emptySnapshot,
      domSnapshot: emptyDomSnapshot,
      consoleAdded: [],
      eventLogAdded: [],
      entitiesAfter: { BrowseItem: [{ id: '1', name: 'A' }] },
      screenshotPath: null,
    });

    expect(frame.cause.event).toBe('INIT');
    expect(frame.cause.from).toBe('loading');
    expect(frame.cause.to).toBe('loading');
    expect(frame.cause.triggerKind).toBe('auto-init');
    expect(frame.stateBefore).toBeNull();
    expect(frame.stateAfter).toBe('loading');
    expect(frame.accepted).toBe(true);
    // entitiesBefore is empty so all post-mount rows are "added"
    expect(frame.entityChanges[0].added).toHaveLength(1);
  });

  it("produces a coverage key matching the kernel's denominator", () => {
    const frame = makeInitFrame({
      index: 0,
      timestamp: 0,
      traitName: 'BrowseItemBrowse',
      initialState: 'loading',
      runtimeSnapshot: emptySnapshot,
      domSnapshot: emptyDomSnapshot,
      consoleAdded: [],
      eventLogAdded: [],
      entitiesAfter: {},
      screenshotPath: null,
    });
    expect(keyOf(frame.cause)).toBe('BrowseItemBrowse:loading+INIT->loading');
  });
});
