import { describe, it, expect } from 'vitest';
import type { EffectTrace, OrbitalSchema, RawUserClaims } from '@almadar/core';
import { planUserCrudFlow } from '../plan-user-crud-flow.js';
import { extractTraitWalkConfigs } from '../extract-trait-walk-configs.js';
import { createFakeDriver, type FakeDriverContext } from '../../driver/impls/fake.js';
import { tick } from '../../driver/tick.js';

/**
 * C1-V10 item 1: `planUserCrudFlow`'s crud-edit/crud-delete steps now carry
 * a `viewerRequirement` (`plan-user-crud-flow.test.ts` proves the field is
 * derived correctly at the planner level). This file proves `tick()` —
 * already generically wired for `viewerRequirement` by C1-V9 — actually
 * switches persona for a step `planUserCrudFlow` produced, end to end
 * through the fake driver, the same way it already does for
 * `planDataMutationTests` steps (`plan-data-mutation-tests-viewer.test.ts`).
 *
 * `FakeDriver.triggerDOM` has no DOM: it dispatches `step.event` (the
 * modal/confirm trait's own OPEN transition) directly via `sendEvent`, so
 * the fixture's OPEN transition carries a `set` effect purely so
 * `executeEffects` gets a chance to observe the ACTIVE persona at dispatch
 * time — real crud-edit/delete OPEN transitions declare no such effect
 * (the persist lives on the persistor, fired later via the real DOM's
 * submit/confirm click, which the fake driver doesn't simulate).
 */
function ownershipPolicedListShape(): OrbitalSchema {
  const ownerPolicy = ['=', ['object/get', '@entity', 'authorId'], '@user.id'];
  return {
    name: 'std-list-owner-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'ListItemOrbital',
        entity: {
          name: 'ListItem',
          persistence: 'persistent',
          fields: [
            { name: 'id', type: 'string', required: true },
            { name: 'name', type: 'string', required: true },
            { name: 'authorId', type: 'string', required: true },
          ],
          update_policy: ownerPolicy,
          delete_policy: ownerPolicy,
        },
        pages: [],
        traits: [
          {
            name: 'ListItemEdit',
            scope: 'instance',
            linkedEntity: 'ListItem',
            stateMachine: {
              states: [{ name: 'closed', isInitial: true }, { name: 'open' }],
              events: [
                { key: 'INIT', name: 'Init' },
                { key: 'EDIT', name: 'Edit' },
                { key: 'LIST_ITEM_UPDATED', name: 'Save', payloadSchema: [{ name: 'data', type: 'object', required: true }] },
              ],
              transitions: [
                {
                  from: 'closed',
                  to: 'open',
                  event: 'EDIT',
                  // Test-only observability hook — see file doc.
                  effects: [['set', '@entity.lastOpenedBy', '@user.id']],
                },
                { from: 'open', to: 'closed', event: 'LIST_ITEM_UPDATED' },
              ],
            },
          },
          {
            name: 'ListItemDelete',
            scope: 'instance',
            linkedEntity: 'ListItem',
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
                  // Test-only observability hook — see file doc.
                  effects: [['set', '@entity.lastOpenedBy', '@user.id']],
                },
                { from: 'confirming', to: 'idle', event: 'CONFIRM_DELETE' },
              ],
            },
          },
          {
            name: 'ListItemPersistor',
            scope: 'instance',
            linkedEntity: 'ListItem',
            listens: [
              { event: 'LIST_ITEM_UPDATED', triggers: 'DO_UPDATE', source: { kind: 'trait', trait: 'ListItemEdit' } },
              { event: 'CONFIRM_DELETE', triggers: 'DO_DELETE', source: { kind: 'trait', trait: 'ListItemDelete' } },
            ],
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [
                { key: 'INIT', name: 'Init' },
                { key: 'DO_UPDATE', name: 'Do Update' },
                { key: 'DO_DELETE', name: 'Do Delete' },
              ],
              transitions: [
                {
                  from: 'idle',
                  to: 'idle',
                  event: 'DO_UPDATE',
                  effects: [['persist', 'update', 'ListItem', { data: '@payload.data', emit: { success: 'ITEM_UPDATED' } }]],
                },
                {
                  from: 'idle',
                  to: 'idle',
                  event: 'DO_DELETE',
                  effects: [['persist', 'delete', 'ListItem', { id: '@payload.id', emit: { success: 'ITEM_DELETED' } }]],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('planUserCrudFlow viewer switch, through tick() (C1-V10 item 1)', () => {
  it('crud-edit: switches persona to the target row\'s owner before dispatch and restores the default after', async () => {
    const schema = ownershipPolicedListShape();
    const steps = planUserCrudFlow(schema);
    const edit = steps.find((s) => s.testKind === 'crud-edit');
    expect(edit).toBeDefined();
    expect(edit?.viewerRequirement).toEqual({ owner: { sourceEntity: 'ListItem', sourceField: 'authorId' } });

    const traits = extractTraitWalkConfigs(schema);
    let capturedPersona: RawUserClaims | null = null;
    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (_effects, { persona }) => {
        capturedPersona = persona;
        const traces: EffectTrace[] = [{ type: 'set', args: [], status: 'executed' }];
        return { effects: traces, emitted: [] };
      },
    });

    const ctx: FakeDriverContext = { outputDir: '', trait: traits.find((t) => t.traitName === 'ListItemEdit')!, runtime };
    await driver.reset(ctx);
    // Row 0 (structural position) belongs to a DIFFERENT identity than the
    // walk's default persona — the DOM's own row-scoped click convention
    // (`targetRowId` undefined -> first `[data-row-id]`) targets the SAME
    // row `tick()`'s owner lookup reads (`entitiesBefore[entityName]?.[0]`).
    runtime.seed('ListItem', [{ id: 'item-1', authorId: 'author-9' }]);

    const initFrame = await tick(driver, ctx, null, {
      from: 'closed',
      event: 'INIT',
      to: 'closed',
      guardCase: null,
      payload: {},
      isRepositioning: false,
      traitName: 'ListItemEdit',
      triggerKind: 'auto-init',
      coverageKey: 'ListItemEdit:auto-init',
    });

    const frame = await tick(driver, ctx, initFrame, edit!, undefined, undefined, { id: 'default-viewer' });

    expect(capturedPersona).toEqual({ id: 'author-9' });
    expect(runtime.getPersona()).toEqual({ id: 'default-viewer' });
    expect(frame.errors ?? []).toEqual([]);
    expect(frame.accepted).toBe(true);
  });

  it('crud-delete: switches persona to the target row\'s owner before dispatch and restores the default after', async () => {
    const schema = ownershipPolicedListShape();
    const steps = planUserCrudFlow(schema);
    const del = steps.find((s) => s.testKind === 'crud-delete');
    expect(del).toBeDefined();
    expect(del?.viewerRequirement).toEqual({ owner: { sourceEntity: 'ListItem', sourceField: 'authorId' } });

    const traits = extractTraitWalkConfigs(schema);
    let capturedPersona: RawUserClaims | null = null;
    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (_effects, { persona }) => {
        capturedPersona = persona;
        const traces: EffectTrace[] = [{ type: 'set', args: [], status: 'executed' }];
        return { effects: traces, emitted: [] };
      },
    });

    const ctx: FakeDriverContext = { outputDir: '', trait: traits.find((t) => t.traitName === 'ListItemDelete')!, runtime };
    await driver.reset(ctx);
    runtime.seed('ListItem', [{ id: 'item-1', authorId: 'author-9' }]);

    const initFrame = await tick(driver, ctx, null, {
      from: 'idle',
      event: 'INIT',
      to: 'idle',
      guardCase: null,
      payload: {},
      isRepositioning: false,
      traitName: 'ListItemDelete',
      triggerKind: 'auto-init',
      coverageKey: 'ListItemDelete:auto-init',
    });

    const frame = await tick(driver, ctx, initFrame, del!, undefined, undefined, { id: 'default-viewer' });

    expect(capturedPersona).toEqual({ id: 'author-9' });
    expect(runtime.getPersona()).toEqual({ id: 'default-viewer' });
    expect(frame.errors ?? []).toEqual([]);
    expect(frame.accepted).toBe(true);
  });

  it('fails closed with no-satisfying-persona when the target row carries no owner value', async () => {
    const schema = ownershipPolicedListShape();
    const steps = planUserCrudFlow(schema);
    const edit = steps.find((s) => s.testKind === 'crud-edit');

    const traits = extractTraitWalkConfigs(schema);
    const dispatched: string[] = [];
    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (_effects, { event }) => {
        dispatched.push(event);
        return { effects: [], emitted: [] };
      },
    });

    const ctx: FakeDriverContext = { outputDir: '', trait: traits.find((t) => t.traitName === 'ListItemEdit')!, runtime };
    await driver.reset(ctx);
    // Seeded row exists, but its owner column is unset.
    runtime.seed('ListItem', [{ id: 'item-1' }]);

    const initFrame = await tick(driver, ctx, null, {
      from: 'closed',
      event: 'INIT',
      to: 'closed',
      guardCase: null,
      payload: {},
      isRepositioning: false,
      traitName: 'ListItemEdit',
      triggerKind: 'auto-init',
      coverageKey: 'ListItemEdit:auto-init',
    });

    const frame = await tick(driver, ctx, initFrame, edit!, undefined, undefined, { id: 'default-viewer' });

    expect(dispatched).toEqual([]);
    expect(frame.accepted).toBe(false);
    expect(frame.errors?.[0]).toMatch(/^no-satisfying-persona:/);
  });
});
