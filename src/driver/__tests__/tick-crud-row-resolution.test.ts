/**
 * C1-V11 (rung 3): the user-crud flow's row targeting must never click a
 * row the runtime's own `onDelete: restrict` rule will reject. This file
 * proves `tick()`'s dynamic row resolution end to end through the fake
 * driver:
 *
 *   1. an unreferenced, owned row is picked; `targetRowId` and the
 *      dispatched payload both reflect it; the viewer switches to that
 *      row's owner (not row 0's).
 *   2. when EVERY row is referenced (a fully-connected self-relation
 *      seed), the frame fails closed with a `no-target-row` finding and
 *      never dispatches.
 *   3. a bus-fallback dispatch (no DOM affordance found) still carries the
 *      picked row's id, never a bare `{}`.
 *
 * @packageDocumentation
 */
import { describe, it, expect } from 'vitest';
import type { EffectTrace, OrbitalSchema, RawUserClaims } from '@almadar/core';
import { planUserCrudFlow } from '../../planner/plan-user-crud-flow.js';
import { extractTraitWalkConfigs } from '../../planner/extract-trait-walk-configs.js';
import { createFakeDriver, type FakeDriverContext } from '../impls/fake.js';
import { tick } from '../tick.js';
import type { Driver } from '../types.js';

/**
 * `Note` self-relates via `parentId` (mirrors std-notes) AND declares an
 * owner-checked `delete_policy` (mirrors the ownership-policed fixtures
 * elsewhere in this package) — so a correct row pick must satisfy BOTH
 * constraints at once: unreferenced by any other row's `parentId`, and
 * owned by whichever persona `tick()` switches to.
 */
function selfRelatingOwnedNoteSchema(): OrbitalSchema {
  const ownerPolicy = ['=', ['object/get', '@entity', 'authorId'], '@user.id'];
  return {
    name: 'note-self-relation-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'NoteOrbital',
        entity: {
          name: 'Note',
          persistence: 'persistent',
          fields: [
            { name: 'id', type: 'string', required: true },
            { name: 'parentId', type: 'relation', relation: { entity: 'Note', cardinality: 'one' } },
            { name: 'authorId', type: 'string', required: true },
          ],
          delete_policy: ownerPolicy,
        },
        pages: [],
        traits: [
          {
            name: 'NoteDelete',
            scope: 'instance',
            linkedEntity: 'Note',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'confirming' }],
              events: [
                { key: 'INIT', name: 'Init' },
                { key: 'DELETE', name: 'Delete' },
                { key: 'CONFIRM_DELETE', name: 'Confirm' },
              ],
              transitions: [
                {
                  from: 'idle',
                  to: 'confirming',
                  event: 'DELETE',
                  effects: [
                    // Test-only observability hook, mirrors
                    // plan-user-crud-flow-viewer.test.ts: lets
                    // `executeEffects` capture the ACTIVE persona at
                    // dispatch time.
                    ['set', '@entity.lastOpenedBy', '@user.id'],
                    // C1-V18: a genuine overlay-form open affordance —
                    // see plan-user-crud-flow.ts's isOverlayFormOpen.
                    ['render-ui', 'modal', {
                      type: 'stack',
                      children: [{ type: 'button', action: 'CONFIRM_DELETE', label: 'Delete' }],
                    }],
                  ],
                },
                { from: 'confirming', to: 'idle', event: 'CONFIRM_DELETE' },
              ],
            },
          },
          {
            name: 'NotePersistor',
            scope: 'instance',
            linkedEntity: 'Note',
            listens: [
              { event: 'CONFIRM_DELETE', triggers: 'DO_DELETE', source: { kind: 'trait', trait: 'NoteDelete' } },
            ],
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [
                { key: 'INIT', name: 'Init' },
                { key: 'DO_DELETE', name: 'Do Delete' },
              ],
              transitions: [
                {
                  from: 'idle',
                  to: 'idle',
                  event: 'DO_DELETE',
                  effects: [['persist', 'delete', 'Note', { id: '@payload.id', emit: { success: 'NOTE_DELETED' } }]],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function runAutoInit(
  driver: Driver<FakeDriverContext>,
  ctx: FakeDriverContext,
  from: string,
  traitName: string,
) {
  return tick(driver, ctx, null, {
    from,
    event: 'INIT',
    to: from,
    guardCase: null,
    payload: {},
    isRepositioning: false,
    traitName,
    triggerKind: 'auto-init',
    coverageKey: `${traitName}:auto-init`,
  });
}

/**
 * C1-V17: `Channel` declares NO self-relation at all — only
 * `ChannelMember.channel` restrict-relates to it (a DIFFERENT entity). A
 * self-relation-only reader would never know a `Channel` delete can be
 * blocked at all, let alone by which rows.
 */
function crossEntityRestrictedChannelSchema(): OrbitalSchema {
  return {
    name: 'channel-cross-entity-restrict-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'ChannelOrbital',
        entity: { name: 'Channel', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] },
        auxiliaryEntities: [
          {
            name: 'ChannelMember',
            persistence: 'persistent',
            fields: [
              { name: 'id', type: 'string', required: true },
              { name: 'channel', type: 'relation', relation: { entity: 'Channel', cardinality: 'one' } },
            ],
          },
        ],
        pages: [],
        traits: [
          {
            name: 'ChannelDelete',
            scope: 'instance',
            linkedEntity: 'Channel',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'confirming' }],
              events: [
                { key: 'INIT', name: 'Init' },
                { key: 'DELETE', name: 'Delete' },
                { key: 'CONFIRM_DELETE', name: 'Confirm' },
              ],
              transitions: [
                {
                  from: 'idle',
                  to: 'confirming',
                  event: 'DELETE',
                  // C1-V18: a genuine overlay-form open affordance — see
                  // plan-user-crud-flow.ts's isOverlayFormOpen.
                  effects: [['render-ui', 'modal', {
                    type: 'stack',
                    children: [{ type: 'button', action: 'CONFIRM_DELETE', label: 'Delete' }],
                  }]],
                },
                { from: 'confirming', to: 'idle', event: 'CONFIRM_DELETE' },
              ],
            },
          },
          {
            name: 'ChannelPersistor',
            scope: 'instance',
            linkedEntity: 'Channel',
            listens: [
              { event: 'CONFIRM_DELETE', triggers: 'DO_DELETE', source: { kind: 'trait', trait: 'ChannelDelete' } },
            ],
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [
                { key: 'INIT', name: 'Init' },
                { key: 'DO_DELETE', name: 'Do Delete' },
              ],
              transitions: [
                {
                  from: 'idle',
                  to: 'idle',
                  event: 'DO_DELETE',
                  effects: [['persist', 'delete', 'Channel', { id: '@payload.id', emit: { success: 'CHANNEL_DELETED' } }]],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('tick — crud row resolution, cross-entity restrict relation (C1-V17)', () => {
  it('planUserCrudFlow attaches avoidReferencedByOtherEntities for a cross-entity (non-self) restrict relation', () => {
    const schema = crossEntityRestrictedChannelSchema();
    const del = planUserCrudFlow(schema).find((s) => s.testKind === 'crud-delete');
    expect(del?.avoidReferencedVia).toBeUndefined();
    expect(del?.avoidReferencedByOtherEntities).toEqual([{ entityName: 'ChannelMember', fieldName: 'channel' }]);
  });

  it('picks the Channel row NOT referenced by any ChannelMember, never row 0 just because it has no SELF-relation', async () => {
    const schema = crossEntityRestrictedChannelSchema();
    const del = planUserCrudFlow(schema).find((s) => s.testKind === 'crud-delete');
    expect(del).toBeDefined();

    const traits = extractTraitWalkConfigs(schema);
    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: () => ({ effects: [{ type: 'set', args: [], status: 'executed' }], emitted: [] }),
    });

    const ctx: FakeDriverContext = { outputDir: '', trait: traits.find((t) => t.traitName === 'ChannelDelete')!, runtime };
    await driver.reset(ctx);
    // Row 0 ('chan-a') IS referenced by a ChannelMember row — the correct
    // pick is 'chan-b', the one no OTHER entity's row references.
    runtime.seed('Channel', [{ id: 'chan-a' }, { id: 'chan-b' }]);
    runtime.seed('ChannelMember', [{ id: 'mem-1', channel: 'chan-a' }]);

    const initFrame = await runAutoInit(driver, ctx, 'idle', 'ChannelDelete');
    const frame = await tick(driver, ctx, initFrame, del!, undefined, undefined, { id: 'default-viewer' });

    expect(del?.targetRowId).toBe('chan-b');
    expect(frame.cause.targetRowId).toBe('chan-b');
    expect(frame.payload).toEqual({ id: 'chan-b' });
    expect(frame.errors ?? []).toEqual([]);
    expect(frame.accepted).toBe(true);
  });

  it('fails closed with a no-deletable-row finding (not no-target-row) when EVERY row is cross-entity referenced', async () => {
    const schema = crossEntityRestrictedChannelSchema();
    const del = planUserCrudFlow(schema).find((s) => s.testKind === 'crud-delete');

    const traits = extractTraitWalkConfigs(schema);
    const dispatched: string[] = [];
    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (_effects, { event }) => {
        dispatched.push(event);
        return { effects: [], emitted: [] };
      },
    });

    const ctx: FakeDriverContext = { outputDir: '', trait: traits.find((t) => t.traitName === 'ChannelDelete')!, runtime };
    await driver.reset(ctx);
    // Both Channel rows have at least one ChannelMember referencing them —
    // both are genuinely undeletable, not merely a row-0 quirk.
    runtime.seed('Channel', [{ id: 'chan-a' }, { id: 'chan-b' }]);
    runtime.seed('ChannelMember', [
      { id: 'mem-1', channel: 'chan-a' },
      { id: 'mem-2', channel: 'chan-b' },
    ]);

    const initFrame = await runAutoInit(driver, ctx, 'idle', 'ChannelDelete');
    const frame = await tick(driver, ctx, initFrame, del!, undefined, undefined, { id: 'default-viewer' });

    expect(dispatched).toEqual([]);
    expect(del?.targetRowId).toBeUndefined();
    expect(frame.accepted).toBe(false);
    expect(frame.errors).toHaveLength(1);
    // Distinct prefix from the self-relation `no-target-row:` case — every
    // candidate IS a real, existing row; the restrict rule is what blocks
    // deleting any of them.
    expect(frame.errors?.[0]).toMatch(/^no-deletable-row:/);
    expect(frame.errors?.[0]).toContain('every candidate row is referenced');
  });
});

describe('tick — crud row resolution (C1-V11)', () => {
  it('picks an unreferenced owned row, sets targetRowId, switches the viewer to its owner, and dispatches against it', async () => {
    const schema = selfRelatingOwnedNoteSchema();
    const del = planUserCrudFlow(schema).find((s) => s.testKind === 'crud-delete');
    expect(del).toBeDefined();
    expect(del?.avoidReferencedVia).toEqual(['parentId']);
    expect(del?.viewerRequirement).toEqual({ owner: { sourceEntity: 'Note', sourceField: 'authorId' } });

    const traits = extractTraitWalkConfigs(schema);
    let capturedPersona: RawUserClaims | null = null;
    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (_effects, { persona }) => {
        capturedPersona = persona;
        const traces: EffectTrace[] = [{ type: 'set', args: [], status: 'executed' }];
        return { effects: traces, emitted: [] };
      },
    });

    const ctx: FakeDriverContext = { outputDir: '', trait: traits.find((t) => t.traitName === 'NoteDelete')!, runtime };
    await driver.reset(ctx);
    // 'note-root' is a root referenced by 'note-child' via parentId — the
    // mock seeder's tree shape (row 0 is always a root with children).
    // The correct pick is 'note-child': unreferenced AND owned by
    // whichever persona the walk switches to.
    runtime.seed('Note', [
      { id: 'note-root', parentId: '', authorId: 'author-root' },
      { id: 'note-child', parentId: 'note-root', authorId: 'author-child' },
    ]);

    const initFrame = await runAutoInit(driver, ctx, 'idle', 'NoteDelete');
    const frame = await tick(driver, ctx, initFrame, del!, undefined, undefined, { id: 'default-viewer' });

    expect(del?.targetRowId).toBe('note-child');
    expect(frame.cause.targetRowId).toBe('note-child');
    expect(frame.payload).toEqual({ id: 'note-child' });
    expect(capturedPersona).toEqual({ id: 'author-child' });
    expect(runtime.getPersona()).toEqual({ id: 'default-viewer' });
    expect(frame.errors ?? []).toEqual([]);
    expect(frame.accepted).toBe(true);
  });

  it('fails the frame closed with a no-deletable-row finding when every row is referenced, and never dispatches', async () => {
    const schema = selfRelatingOwnedNoteSchema();
    const del = planUserCrudFlow(schema).find((s) => s.testKind === 'crud-delete');
    expect(del?.avoidReferencedVia).toEqual(['parentId']);

    const traits = extractTraitWalkConfigs(schema);
    const dispatched: string[] = [];
    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (_effects, { event }) => {
        dispatched.push(event);
        return { effects: [], emitted: [] };
      },
    });

    const ctx: FakeDriverContext = { outputDir: '', trait: traits.find((t) => t.traitName === 'NoteDelete')!, runtime };
    await driver.reset(ctx);
    // A cycle — every row is referenced by another, so no candidate can
    // ever be safely deleted.
    runtime.seed('Note', [
      { id: 'note-a', parentId: 'note-b', authorId: 'author-a' },
      { id: 'note-b', parentId: 'note-a', authorId: 'author-b' },
    ]);

    const initFrame = await runAutoInit(driver, ctx, 'idle', 'NoteDelete');
    const frame = await tick(driver, ctx, initFrame, del!, undefined, undefined, { id: 'default-viewer' });

    expect(dispatched).toEqual([]);
    expect(del?.targetRowId).toBeUndefined();
    expect(frame.accepted).toBe(false);
    expect(frame.errors).toHaveLength(1);
    // C1-V17: 'all-referenced' now gets its own prefix — every candidate
    // IS a real row, but the restrict rule blocks deleting any of them
    // (distinct from `no-target-row`'s "nothing to pick from at all").
    expect(frame.errors?.[0]).toMatch(/^no-deletable-row:/);
    // The trait never actually advanced — the dispatch was skipped, not
    // attempted-and-rejected.
    expect(await driver.getState(ctx, 'NoteDelete')).toBe('idle');
  });

  it('a bus-fallback dispatch (no DOM affordance found) carries the picked row\'s id, never a bare payload', async () => {
    const schema = selfRelatingOwnedNoteSchema();
    const del = planUserCrudFlow(schema).find((s) => s.testKind === 'crud-delete');

    const traits = extractTraitWalkConfigs(schema);
    const { driver, runtime } = createFakeDriver(traits);
    // Force the DOM search to miss entirely (a plain `false`, not
    // 'no-row-affordance') so `tick()` falls back to the bus — mirrors a
    // `isRowAction === false` single-button affordance the click probe
    // failed to find.
    const sentPayloads: unknown[] = [];
    const noAffordanceDriver: Driver<FakeDriverContext> = {
      ...driver,
      async triggerDOM() {
        return false;
      },
      async sendEvent(sendCtx, event, payload, scope) {
        sentPayloads.push(payload);
        return driver.sendEvent(sendCtx, event, payload, scope);
      },
    };

    const ctx: FakeDriverContext = { outputDir: '', trait: traits.find((t) => t.traitName === 'NoteDelete')!, runtime };
    await driver.reset(ctx);
    runtime.seed('Note', [
      { id: 'note-root', parentId: '', authorId: 'author-root' },
      { id: 'note-child', parentId: 'note-root', authorId: 'author-child' },
    ]);

    const initFrame = await runAutoInit(noAffordanceDriver, ctx, 'idle', 'NoteDelete');
    const frame = await tick(noAffordanceDriver, ctx, initFrame, del!, undefined, undefined, { id: 'default-viewer' });

    expect(frame.cause.triggerKind).toBe('bus');
    expect(sentPayloads).toEqual([{ id: 'note-child' }]);
    expect(frame.payload).toEqual({ id: 'note-child' });
  });
});
