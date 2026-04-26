import { describe, it, expect } from 'vitest';
import type { EntityRow, VerificationSnapshot } from '@almadar/core';
import { assertMutation } from '../assert-mutation.js';
import type { Frame, FrameCause, EntityChange } from '../../frame/types.js';
import type { EntityFieldLike } from '../../browser/catalog-probes.js';

const emptySnapshot: VerificationSnapshot = {
  checks: [],
  transitions: [],
  bridge: null,
  summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
  traits: [],
};
const emptyDom = { url: '', rowsByEntity: {}, portals: [], visibleTextSample: '' };

const dummyCause: FrameCause = {
  traitName: 'CartItemAddItem',
  from: 'idle',
  event: 'SAVE',
  to: 'idle',
  guardCase: null,
  triggerKind: 'bus',
  isRepositioning: false,
};

function frameWith(changes: ReadonlyArray<EntityChange>): Frame {
  return {
    index: 1,
    timestamp: 1000,
    cause: dummyCause,
    stateBefore: 'idle',
    stateAfter: 'idle',
    payload: {},
    eventFired: 'SAVE',
    runtimeSnapshot: emptySnapshot,
    domSnapshot: emptyDom,
    consoleDelta: { added: [], newErrors: 0, newWarnings: 0 },
    eventLogDelta: { added: [] },
    entityChanges: changes,
    effectResults: [],
    serverResponse: null,
    screenshotPath: null,
    accepted: true,
    errors: [],
    warnings: [],
  };
}

describe('assertMutation — count delta', () => {
  it('passes when added.length matches +1 expected', () => {
    const change: EntityChange = {
      entityName: 'CartItem',
      before: [],
      after: [{ id: '1', name: 'Apple' }],
      added: [{ id: '1', name: 'Apple' }],
      removed: [],
      changed: [],
    };
    const verdict = assertMutation(frameWith([change]), null, {
      entityName: 'CartItem',
      expectedDelta: 1,
    });
    expect(verdict.passed).toBe(true);
  });

  it('fails when count delta is wrong', () => {
    const change: EntityChange = {
      entityName: 'CartItem',
      before: [],
      after: [],
      added: [],
      removed: [],
      changed: [],
    };
    const verdict = assertMutation(frameWith([change]), null, {
      entityName: 'CartItem',
      expectedDelta: 1,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.detail).toMatch(/expected delta 1.*got 0/);
  });

  it('fails when no entity change exists for the named entity', () => {
    const verdict = assertMutation(frameWith([]), null, {
      entityName: 'CartItem',
      expectedDelta: 1,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.detail).toMatch(/no entity change recorded/);
  });
});

describe('assertMutation — content (VG11f) — the regression-prevention test', () => {
  // This is the bug VG11f was built to catch: SAVE emits an EMPTY
  // payload, the runtime grows the entity count by +1, but the new
  // row has blank required fields. Count-only check passes; content
  // check must catch it.
  const requiredFields: EntityFieldLike[] = [
    { name: 'name', type: 'string', required: true },
    { name: 'description', type: 'string', required: true },
    { name: 'id', type: 'string', required: true }, // framework — always skipped
  ];

  it('FAILS when a required field is missing/empty even though count delta is correct', () => {
    const change: EntityChange = {
      entityName: 'CartItem',
      before: [],
      after: [{ id: '1', name: '', description: '' } as EntityRow], // BLANK required fields
      added: [{ id: '1', name: '', description: '' } as EntityRow],
      removed: [],
      changed: [],
    };
    const verdict = assertMutation(frameWith([change]), null, {
      entityName: 'CartItem',
      expectedDelta: 1,
      requiredFields,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.detail).toMatch(/content failed/);
    expect(verdict.evidence?.rowsInspected).toHaveLength(1);
    const insp = verdict.evidence?.rowsInspected?.[0];
    expect(insp?.passed).toBe(false);
    const failedFields = insp?.checks.filter((c) => !c.present).map((c) => c.field).sort();
    expect(failedFields).toEqual(['description', 'name']);
  });

  it('PASSES when count + every required field is populated', () => {
    const change: EntityChange = {
      entityName: 'CartItem',
      before: [],
      after: [{ id: '1', name: 'Apple', description: 'red fruit' } as EntityRow],
      added: [{ id: '1', name: 'Apple', description: 'red fruit' } as EntityRow],
      removed: [],
      changed: [],
    };
    const verdict = assertMutation(frameWith([change]), null, {
      entityName: 'CartItem',
      expectedDelta: 1,
      requiredFields,
    });
    expect(verdict.passed).toBe(true);
    expect(verdict.evidence?.rowsInspected?.[0].passed).toBe(true);
  });

  it('skips framework-managed fields (id, createdAt, updatedAt) even when blank', () => {
    const change: EntityChange = {
      entityName: 'CartItem',
      before: [],
      after: [{ id: '', name: 'Apple', description: 'X' } as EntityRow],
      added: [{ id: '', name: 'Apple', description: 'X' } as EntityRow],
      removed: [],
      changed: [],
    };
    const verdict = assertMutation(frameWith([change]), null, {
      entityName: 'CartItem',
      expectedDelta: 1,
      requiredFields,
    });
    // id is blank but framework-managed; not counted.
    expect(verdict.passed).toBe(true);
  });

  it('skips fields with a declared default even when the row value is blank', () => {
    const fields: EntityFieldLike[] = [
      { name: 'pendingId', type: 'string', required: true, default: '' },
    ];
    const change: EntityChange = {
      entityName: 'CartItem',
      before: [],
      after: [{ id: '1', pendingId: '' } as EntityRow],
      added: [{ id: '1', pendingId: '' } as EntityRow],
      removed: [],
      changed: [],
    };
    const verdict = assertMutation(frameWith([change]), null, {
      entityName: 'CartItem',
      expectedDelta: 1,
      requiredFields: fields,
    });
    expect(verdict.passed).toBe(true);
  });
});
