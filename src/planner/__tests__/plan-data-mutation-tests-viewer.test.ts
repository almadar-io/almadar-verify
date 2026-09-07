import { describe, it, expect } from 'vitest';
import type { EffectTrace, OrbitalSchema, RawUserClaims } from '@almadar/core';
import { planDataMutationTests } from '../plan-data-mutation-tests.js';
import { extractTraitWalkConfigs } from '../extract-trait-walk-configs.js';
import { createFakeDriver, type FakeDriverContext } from '../../driver/impls/fake.js';
import { tick } from '../../driver/tick.js';

/**
 * C1-V9 items A + B, exercised end to end through `tick()` (fake driver):
 * a persist step whose entity declares an OWNERSHIP access policy, with
 * the target row carried in the step's OWN payload (item B's persistor
 * shape — `(persist update Note ?data)`, `data : @entity!`) — the exact
 * `std-notes` `NotePersistor.DO_UPDATE` shape (`Note.@update ["=",
 * (object/get @entity authorId), @user.id]`).
 */
function noteUpdateSchema(): OrbitalSchema {
  return {
    name: 'note-update-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'NoteOrbital',
        entity: {
          name: 'Note',
          persistence: 'persistent',
          collection: 'notes',
          fields: [
            { name: 'id', type: 'string', required: true },
            { name: 'authorId', type: 'string', required: true },
          ],
          update_policy: ['=', ['object/get', '@entity', 'authorId'], '@user.id'],
        },
        pages: [],
        traits: [
          {
            name: 'NotePersistor',
            scope: 'instance',
            linkedEntity: 'Note',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [
                { key: 'INIT', name: 'Init' },
                {
                  key: 'DO_UPDATE',
                  name: 'Update note',
                  payloadSchema: [{ name: 'data', type: 'object', required: true, entity: 'Note' }],
                },
              ],
              transitions: [
                { from: 'idle', to: 'idle', event: 'INIT' },
                {
                  from: 'idle',
                  to: 'idle',
                  event: 'DO_UPDATE',
                  effects: [['persist', 'update', 'Note', '@payload.data', { emit: { success: 'NOTE_UPDATED' } }]],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Same ownership shape on `@create` — the create's OWN payload must
 *  self-declare `authorId` as the switched-to viewer's id. */
function noteCreateSchema(): OrbitalSchema {
  return {
    name: 'note-create-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'NoteOrbital',
        entity: {
          name: 'Note',
          persistence: 'persistent',
          collection: 'notes',
          fields: [
            { name: 'id', type: 'string', required: true },
            { name: 'authorId', type: 'string', required: true },
            { name: 'title', type: 'string', required: true },
          ],
          create_policy: ['=', ['object/get', '@entity', 'authorId'], '@user.id'],
        },
        pages: [],
        traits: [
          {
            name: 'NotePersistor',
            scope: 'instance',
            linkedEntity: 'Note',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [
                { key: 'INIT', name: 'Init' },
                {
                  key: 'DO_CREATE',
                  name: 'Create note',
                  payloadSchema: [
                    { name: 'authorId', type: 'string', required: true },
                    { name: 'title', type: 'string', required: true },
                  ],
                },
              ],
              transitions: [
                { from: 'idle', to: 'idle', event: 'INIT' },
                {
                  from: 'idle',
                  to: 'idle',
                  event: 'DO_CREATE',
                  effects: [
                    [
                      'persist',
                      'create',
                      'Note',
                      { authorId: '@payload.authorId', title: '@payload.title' },
                      { emit: { success: 'NOTE_CREATED' } },
                    ],
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Simulates `checkMutationAccess`: `owns` iff the row/payload's own
 *  `authorId` equals the dispatch-time persona's `id`. */
function persistOutcome(owns: boolean, action: 'create' | 'update', resultId?: string): EffectTrace {
  return {
    type: 'persist',
    entityName: 'Note',
    action,
    args: [],
    status: owns ? 'executed' : 'failed',
    outcome: owns ? 'success' : 'denied',
    ...(owns && resultId !== undefined && { resultId }),
  };
}

describe('C1-V9 item A (viewer derivation) + item B (persistor payload rows) — end to end via tick()', () => {
  it('update: switches persona to the seeded row\'s OWN owner before dispatch, fills the whole row via bindRowFrom, and the persist succeeds', async () => {
    const schema = noteUpdateSchema();
    const steps = planDataMutationTests(schema);
    const update = steps.find((s) => s.event === 'DO_UPDATE');
    expect(update).toBeDefined();
    expect(update?.bindRowFrom).toEqual({ entityName: 'Note', payloadField: 'data', wholeRow: true });
    expect(update?.viewerRequirement).toEqual({ owner: { sourceEntity: 'Note', sourceField: 'authorId' } });
    expect(update?.establishesRow).toBeUndefined();
    expect(update?.unreachableRowReason).toBeUndefined();

    const traits = extractTraitWalkConfigs(schema);
    let capturedPersona: RawUserClaims | null = null;
    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (effects, { payload, persona }) => {
        capturedPersona = persona;
        const traces: EffectTrace[] = [];
        for (const effect of effects) {
          if (!Array.isArray(effect) || effect[0] !== 'persist' || effect[1] !== 'update') continue;
          const data = payload['data'] as { id?: string; authorId?: string } | undefined;
          const owns = data?.authorId !== undefined && data.authorId === persona?.id;
          traces.push(persistOutcome(owns, 'update', data?.id));
        }
        return { effects: traces, emitted: [] };
      },
    });

    const ctx: FakeDriverContext = { outputDir: '', trait: traits[0]!, runtime };
    await driver.reset(ctx);
    // The seeded row belongs to a DIFFERENT identity than the walk's
    // default persona — exactly the std-notes failure mode.
    runtime.seed('Note', [{ id: 'note-1', authorId: 'author-9' }]);
    const initFrame = await tick(driver, ctx, null, {
      from: 'idle',
      event: 'INIT',
      to: 'idle',
      guardCase: null,
      payload: {},
      isRepositioning: false,
      traitName: 'NotePersistor',
      triggerKind: 'auto-init',
      coverageKey: 'NotePersistor:auto-init',
    });

    const frame = await tick(driver, ctx, initFrame, update!, undefined, undefined, { id: 'author-1' });

    // Switched to the ROW's owner for the dispatch...
    expect(capturedPersona).toEqual({ id: 'author-9' });
    // ...and restored the walk's own default persona afterward.
    expect(runtime.getPersona()).toEqual({ id: 'author-1' });

    const updateTrace = frame.effectResults.find((e) => e.action === 'update');
    expect(updateTrace?.outcome).toBe('success');
    expect(updateTrace?.resultId).toBe('note-1');
    expect(frame.accepted).toBe(true);
    expect(frame.errors ?? []).toEqual([]);
  });

  it('update: fails closed with a no-satisfying-persona finding when the seeded row carries no owner value — never a silent dispatch under the wrong viewer', async () => {
    const schema = noteUpdateSchema();
    const steps = planDataMutationTests(schema);
    const update = steps.find((s) => s.event === 'DO_UPDATE');

    const traits = extractTraitWalkConfigs(schema);
    const dispatched: string[] = [];
    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (_effects, { event }) => {
        dispatched.push(event);
        return { effects: [], emitted: [] };
      },
    });
    const ctx: FakeDriverContext = { outputDir: '', trait: traits[0]!, runtime };
    await driver.reset(ctx);
    // Seeded row exists, but its owner column is unset.
    runtime.seed('Note', [{ id: 'note-1' }]);
    const initFrame = await tick(driver, ctx, null, {
      from: 'idle',
      event: 'INIT',
      to: 'idle',
      guardCase: null,
      payload: {},
      isRepositioning: false,
      traitName: 'NotePersistor',
      triggerKind: 'auto-init',
      coverageKey: 'NotePersistor:auto-init',
    });

    const frame = await tick(driver, ctx, initFrame, update!, undefined, undefined, { id: 'author-1' });

    expect(dispatched).toEqual([]);
    expect(frame.accepted).toBe(false);
    expect(frame.errors?.[0]).toMatch(/^no-satisfying-persona:/);
  });

  it('create: switches persona to the default persona\'s own id and stamps the payload\'s owner field so the new row self-declares ownership', async () => {
    const schema = noteCreateSchema();
    const steps = planDataMutationTests(schema);
    const create = steps.find((s) => s.event === 'DO_CREATE');
    expect(create).toBeDefined();
    expect(create?.viewerRequirement).toEqual({
      // No `[identity]`-tagged entity in this fixture — falls back to the
      // mutated entity's own name; `sourceField` is always `'id'` for
      // `useDefaultId` (the default persona's OWN id, not an owner column).
      owner: { sourceEntity: 'Note', sourceField: 'id', useDefaultId: true, payloadOwnerField: 'authorId' },
    });

    const traits = extractTraitWalkConfigs(schema);
    let capturedPersona: RawUserClaims | null = null;
    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (effects, { payload, persona }) => {
        capturedPersona = persona;
        const traces: EffectTrace[] = [];
        for (const effect of effects) {
          if (!Array.isArray(effect) || effect[0] !== 'persist' || effect[1] !== 'create') continue;
          const owns = payload['authorId'] !== undefined && payload['authorId'] === persona?.id;
          traces.push(persistOutcome(owns, 'create', 'note-new'));
        }
        return { effects: traces, emitted: [] };
      },
    });

    const ctx: FakeDriverContext = { outputDir: '', trait: traits[0]!, runtime };
    await driver.reset(ctx);

    const frame = await tick(driver, ctx, null, create!, undefined, undefined, { id: 'author-1' });

    expect(capturedPersona).toEqual({ id: 'author-1' });
    const createTrace = frame.effectResults.find((e) => e.action === 'create');
    expect(createTrace?.outcome).toBe('success');
    expect(frame.accepted).toBe(true);
    expect(frame.errors ?? []).toEqual([]);
  });

  it('create: fails closed when there is no default persona id to stamp the new row\'s ownership with', async () => {
    const schema = noteCreateSchema();
    const steps = planDataMutationTests(schema);
    const create = steps.find((s) => s.event === 'DO_CREATE');

    const traits = extractTraitWalkConfigs(schema);
    const dispatched: string[] = [];
    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (_effects, { event }) => {
        dispatched.push(event);
        return { effects: [], emitted: [] };
      },
    });
    const ctx: FakeDriverContext = { outputDir: '', trait: traits[0]!, runtime };
    await driver.reset(ctx);

    const frame = await tick(driver, ctx, null, create!, undefined, undefined, null);

    expect(dispatched).toEqual([]);
    expect(frame.accepted).toBe(false);
    expect(frame.errors?.[0]).toMatch(/^no-satisfying-persona:/);
  });
});

/**
 * C1-V9 item B follow-on: `Note.parentId : Note` (a self-relation, mirrors
 * `std-notes.lolo`) PLUS an ownership policy on `@delete` — the exact
 * corpus shape that surfaced a real cross-item bug: picking a delete
 * target that avoids referenced rows (this file's own describe block
 * below) must derive the VIEWER from THAT SAME row's owner, never row 0's
 * — a delete-avoidance pick disagreeing with the ownership pick would
 * switch to a viewer that does not own the row actually being written.
 */
function noteDeleteWithSelfRelationSchema(): OrbitalSchema {
  return {
    name: 'note-delete-self-relation-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'NoteOrbital',
        entity: {
          name: 'Note',
          persistence: 'persistent',
          collection: 'notes',
          fields: [
            { name: 'id', type: 'string', required: true },
            { name: 'authorId', type: 'string', required: true },
            { name: 'parentId', type: 'relation', relation: { entity: 'Note', cardinality: 'one' } },
          ],
          delete_policy: ['=', ['object/get', '@entity', 'authorId'], '@user.id'],
        },
        pages: [],
        traits: [
          {
            name: 'NotePersistor',
            scope: 'instance',
            linkedEntity: 'Note',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [
                { key: 'INIT', name: 'Init' },
                { key: 'DO_DELETE', name: 'Delete note', payloadSchema: [{ name: 'id', type: 'string', required: true }] },
              ],
              transitions: [
                { from: 'idle', to: 'idle', event: 'INIT' },
                {
                  from: 'idle',
                  to: 'idle',
                  event: 'DO_DELETE',
                  effects: [['persist', 'delete', 'Note', '@payload.id', { emit: { success: 'NOTE_DELETED' } }]],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('C1-V9 item B follow-on: self-relation delete row-avoidance stays consistent with item A ownership', () => {
  it('switches to the AVOIDED row\'s own owner, not the referenced root row\'s owner', async () => {
    const schema = noteDeleteWithSelfRelationSchema();
    const steps = planDataMutationTests(schema);
    const del = steps.find((s) => s.event === 'DO_DELETE');
    expect(del?.bindRowFrom).toEqual({
      entityName: 'Note',
      payloadField: 'id',
      wholeRow: false,
      avoidReferencedVia: ['parentId'],
    });
    expect(del?.viewerRequirement).toEqual({ owner: { sourceEntity: 'Note', sourceField: 'authorId' } });

    const traits = extractTraitWalkConfigs(schema);
    let capturedPersona: RawUserClaims | null = null;
    let capturedPayloadId: unknown;
    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (effects, { payload, persona }) => {
        capturedPersona = persona;
        capturedPayloadId = payload['id'];
        const traces: EffectTrace[] = [];
        for (const effect of effects) {
          if (!Array.isArray(effect) || effect[0] !== 'persist' || effect[1] !== 'delete') continue;
          traces.push({ type: 'persist', entityName: 'Note', action: 'delete', args: [], status: 'executed', outcome: 'success', resultId: String(payload['id']) });
        }
        return { effects: traces, emitted: [] };
      },
    });

    const ctx: FakeDriverContext = { outputDir: '', trait: traits[0]!, runtime };
    await driver.reset(ctx);
    // Row 0 ("root") is a referenced parent (owned by a DIFFERENT author
    // than row 1, "child") — the mock seeder's real tree shape.
    runtime.seed('Note', [
      { id: 'root', authorId: 'author-9', parentId: '' },
      { id: 'child', authorId: 'author-1', parentId: 'root' },
    ]);
    const initFrame = await tick(driver, ctx, null, {
      from: 'idle',
      event: 'INIT',
      to: 'idle',
      guardCase: null,
      payload: {},
      isRepositioning: false,
      traitName: 'NotePersistor',
      triggerKind: 'auto-init',
      coverageKey: 'NotePersistor:auto-init',
    });

    const frame = await tick(driver, ctx, initFrame, del!, undefined, undefined, { id: 'default-persona' });

    // Targeted the AVOIDED (non-root) row...
    expect(capturedPayloadId).toBe('child');
    // ...and switched to THAT row's own owner, not root's.
    expect(capturedPersona).toEqual({ id: 'author-1' });
    expect(frame.accepted).toBe(true);
    expect(frame.errors ?? []).toEqual([]);
  });
});
