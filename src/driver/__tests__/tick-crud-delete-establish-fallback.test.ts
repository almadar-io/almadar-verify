/**
 * C1-V15 item C: a crud-delete step whose entity has run OUT of
 * unreferenced rows (a fully-connected self-relation seed, std-time-
 * tracking's `Employee.seedRow`) falls back to the orbital's OWN declared
 * `create` flow — bus-fired directly against the persistor, bypassing its
 * own DOM/form-fill proof — and retries the pick against the post-create
 * server truth. The freshly-created row is unreferenced by construction,
 * so the retry finds it without any special-casing.
 *
 * @packageDocumentation
 */
import { describe, it, expect } from 'vitest';
import type { EdgeWalkTransition, EffectTrace, EntityRow } from '@almadar/core';
import { tick } from '../tick.js';
import { createFakeDriver } from '../impls/fake.js';
import type { TraitWalkConfig } from '../../engine/types.js';
import type { ExtendedWalkStep } from '../../planner/types.js';

function transition(from: string, event: string, to: string): EdgeWalkTransition {
  return { from, event, to, hasGuard: false };
}

const deleteTrait: TraitWalkConfig = {
  traitName: 'NoteDelete',
  initialState: 'idle',
  transitions: [
    transition('idle', 'INIT', 'idle'),
    transition('idle', 'DELETE', 'confirming'),
    transition('confirming', 'CONFIRM_DELETE', 'idle'),
  ],
};

const persistorTrait: TraitWalkConfig = {
  traitName: 'NotePersistor',
  initialState: 'idle',
  transitions: [
    transition('idle', 'INIT', 'idle'),
    { ...transition('idle', 'DO_CREATE', 'idle'), effects: [['persist', 'create', 'Note', '@payload']] },
  ],
};

const orbitalsByTrait = new Map([['NoteDelete', 'NoteOrbital'], ['NotePersistor', 'NoteOrbital']]);

function deleteStep(overrides: Partial<ExtendedWalkStep> = {}): ExtendedWalkStep {
  return {
    from: 'idle',
    event: 'DELETE',
    to: 'confirming',
    guardCase: null,
    payload: {},
    isRepositioning: false,
    traitName: 'NoteDelete',
    triggerKind: 'dom',
    coverageKey: 'NoteDelete:idle+DELETE->confirming[crud-delete]',
    testKind: 'crud-delete',
    expectedRowDelta: { entityName: 'Note', delta: -1 },
    avoidReferencedVia: ['parentId'],
    deleteEstablishFallback: { event: 'DO_CREATE', payload: {}, traitName: 'NotePersistor' },
    ...overrides,
  };
}

let nextId = 0;

describe('tick — crud-delete establish-through-create fallback (C1-V15 item C)', () => {
  it('dispatches the declared create flow and targets the freshly-created (unreferenced) row when every seeded row is referenced', async () => {
    nextId = 0;
    const { driver, runtime } = createFakeDriver([deleteTrait, persistorTrait], {
      executeEffects: (effects) => {
        const traces: EffectTrace[] = [];
        for (const effect of effects) {
          if (!Array.isArray(effect)) continue;
          if (effect[0] === 'persist' && effect[1] === 'create') {
            nextId += 1;
            const created: EntityRow = { id: `new-note-${nextId}`, parentId: '' };
            const existing = runtime.entityData()['Note'] ?? [];
            runtime.seed('Note', [...existing, created]);
            traces.push({ type: 'persist', entityName: 'Note', action: 'create', args: [], status: 'executed', outcome: 'success', resultId: created.id });
          }
        }
        return { effects: traces, emitted: [] };
      },
    });
    const ctx = { outputDir: '/tmp', trait: deleteTrait, runtime };

    // A fully-connected 2-cycle: EVERY seeded row is referenced via
    // `parentId` — no candidate exists for the delete without the fallback.
    runtime.seed('Note', [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ]);

    const init = await tick(driver, ctx, null, deleteStep({ event: 'INIT', to: 'idle', triggerKind: 'auto-init', testKind: undefined, deleteEstablishFallback: undefined, avoidReferencedVia: undefined }), orbitalsByTrait);
    const frame = await tick(driver, ctx, init, deleteStep(), orbitalsByTrait);

    expect(frame.cause.targetRowId).toBe('new-note-1');
    expect(frame.errors ?? []).toEqual([]);
  });

  it('keeps the plain no-target-row finding when there is no declared create fallback', async () => {
    nextId = 0;
    const { driver, runtime } = createFakeDriver([deleteTrait, persistorTrait]);
    const ctx = { outputDir: '/tmp', trait: deleteTrait, runtime };
    runtime.seed('Note', [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ]);

    const init = await tick(driver, ctx, null, deleteStep({ event: 'INIT', to: 'idle', triggerKind: 'auto-init', testKind: undefined, deleteEstablishFallback: undefined, avoidReferencedVia: undefined }), orbitalsByTrait);
    const frame = await tick(driver, ctx, init, deleteStep({ deleteEstablishFallback: undefined }), orbitalsByTrait);

    expect(frame.accepted).toBe(false);
    expect(frame.errors).toHaveLength(1);
    // C1-V17: 'all-referenced' (every row exists but the restrict rule
    // blocks deleting any of them) gets its own `no-deletable-row:` prefix,
    // distinct from `no-target-row:`'s "nothing to pick from at all".
    expect(frame.errors[0]).toContain('no-deletable-row');
    expect(frame.cause.targetRowId).toBeUndefined();
  });
});
