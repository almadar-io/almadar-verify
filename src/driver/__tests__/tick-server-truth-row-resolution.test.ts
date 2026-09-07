/**
 * C1-V12 (rung 3): `tick()`'s row picker must reason about referential
 * integrity over the runtime's FULL server-truth store, never just the
 * browser's previous-frame snapshot (`entitiesFromPrev` — a trait's
 * fetched `data`, a filtered/paged SUBSET of the real mock store). This
 * file proves the fix end to end through the fake driver's new
 * `listEntityRows`:
 *
 *   1. crud-delete: a HIDDEN sibling (never in the previous frame's
 *      snapshot) references the structurally-first VISIBLE candidate —
 *      the picker must avoid it and still find a genuinely safe,
 *      VISIBLE row so the delete succeeds (mirrors the reported
 *      std-notes bug: 5 of 6 rows visible, the referencing child wasn't
 *      among them).
 *   2. bindRowFrom (bus dispatch): the previous frame's snapshot has NO
 *      rows of the entity at all (a page showing zero rows, or a
 *      different page), but the server's full store has one — the
 *      picker binds from the server set instead of failing "no row key".
 *
 * @packageDocumentation
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { planUserCrudFlow } from '../../planner/plan-user-crud-flow.js';
import { extractTraitWalkConfigs } from '../../planner/extract-trait-walk-configs.js';
import { createFakeDriver, type FakeDriverContext } from '../impls/fake.js';
import { tick } from '../tick.js';
import type { Driver } from '../types.js';
import type { ExtendedWalkStep } from '../../planner/types.js';

/** `Note` self-relates via `parentId` (mirrors std-notes) — no owner
 *  policy, keeping this file focused purely on the server-truth question. */
function noteSchema(): OrbitalSchema {
  return {
    name: 'server-truth-row-fixture',
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
          ],
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
                { from: 'idle', to: 'confirming', event: 'DELETE' },
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

describe('tick — server-truth row resolution (C1-V12)', () => {
  it('crud-delete: avoids a row a HIDDEN sibling references (never seen in the previous frame\'s snapshot) and picks a genuinely safe VISIBLE row', async () => {
    const schema = noteSchema();
    const del = planUserCrudFlow(schema).find((s) => s.testKind === 'crud-delete');
    expect(del).toBeDefined();
    expect(del?.avoidReferencedVia).toEqual(['parentId']);

    const traits = extractTraitWalkConfigs(schema);
    const { driver, runtime } = createFakeDriver(traits);

    const ctx: FakeDriverContext = { outputDir: '', trait: traits.find((t) => t.traitName === 'NoteDelete')!, runtime };
    await driver.reset(ctx);
    // Seed exactly what the BROWSER's previous frame will see: a root and
    // two children, structurally the mock seeder's tree shape (row 0 is a
    // root with children).
    runtime.seed('Note', [
      { id: 'root', parentId: '' },
      { id: 'child-1', parentId: 'root' },
      { id: 'child-2', parentId: 'root' },
    ]);
    const initFrame = await runAutoInit(driver, ctx, 'idle', 'NoteDelete');

    // NOW a sibling appears in the server's live store that the captured
    // `initFrame` never saw — mirrors a row on a page/pagination window
    // the browser's last snapshot didn't fetch. It references 'child-1'.
    runtime.seed('Note', [
      { id: 'root', parentId: '' },
      { id: 'child-1', parentId: 'root' },
      { id: 'child-2', parentId: 'root' },
      { id: 'hidden-child', parentId: 'child-1' },
    ]);

    const frame = await tick(driver, ctx, initFrame, del!, undefined, undefined, null);

    // The OLD (browser-only) picker would compute referential safety over
    // just [root, child-1, child-2] and — seeing no visible row
    // referencing child-1 — would incorrectly pick it. The correct pick
    // is child-2: the only row safe against the FULL server-truth set
    // AND visible on the page.
    expect(del?.targetRowId).toBe('child-2');
    expect(frame.cause.targetRowId).toBe('child-2');
    expect(frame.payload).toEqual({ id: 'child-2' });
    expect(frame.errors ?? []).toEqual([]);
    expect(frame.accepted).toBe(true);
  });

  it('bindRowFrom (bus dispatch): binds from the SERVER set when the previous frame\'s snapshot had NO rows of the entity at all', async () => {
    // A direct persist-delete step (bindRowFrom shape) rather than the
    // crud-flow's DOM click — the payload carries the id, no rendered
    // affordance needed, so it should still resolve a real row even when
    // nothing of this entity was ever visible on the page.
    const schema = noteSchema();
    const traits = extractTraitWalkConfigs(schema);
    const dispatchedIds: unknown[] = [];
    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (_effects, { payload }) => {
        dispatchedIds.push((payload as { id?: unknown }).id);
        return { effects: [], emitted: [] };
      },
    });

    const ctx: FakeDriverContext = { outputDir: '', trait: traits.find((t) => t.traitName === 'NotePersistor')!, runtime };
    await driver.reset(ctx);
    // The previous frame captured an EMPTY store for 'Note' — no rows
    // visible on this page at all.
    const initFrame = await runAutoInit(driver, ctx, 'idle', 'NotePersistor');

    // The server's actual store gains a row AFTER that snapshot (a create
    // from elsewhere, or simply a store the browser's fetch never reached).
    runtime.seed('Note', [{ id: 'note-1', parentId: '' }]);

    const step: ExtendedWalkStep = {
      from: 'idle',
      event: 'DO_DELETE',
      to: 'idle',
      guardCase: null,
      payload: {},
      isRepositioning: false,
      traitName: 'NotePersistor',
      triggerKind: 'bus',
      coverageKey: 'NotePersistor:idle+DO_DELETE->idle',
      bindRowFrom: { entityName: 'Note', payloadField: 'id', wholeRow: false },
    };

    const frame = await tick(driver, ctx, initFrame, step);

    expect(dispatchedIds).toEqual(['note-1']);
    expect(frame.payload).toEqual({ id: 'note-1' });
    expect(frame.errors ?? []).toEqual([]);
    expect(frame.accepted).toBe(true);
  });
});
