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
                  effects: [
                    // Test-only observability hook — see file doc.
                    ['set', '@entity.lastOpenedBy', '@user.id'],
                    // C1-V18: a genuine overlay-form open affordance —
                    // see plan-user-crud-flow.ts's isOverlayFormOpen.
                    ['render-ui', 'modal', {
                      type: 'stack',
                      children: [{ type: 'button', action: 'LIST_ITEM_UPDATED', label: 'Save' }],
                    }],
                  ],
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
                  effects: [
                    // Test-only observability hook — see file doc.
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

/**
 * C1-V19 item 6 — reproduces std-realtime-chat's real shape exactly:
 * `ChannelMember.@delete = (or (= @user.role moderator) (= @user.role
 * admin))` — a ROLE-ONLY policy (no owner comparison at all), unlike
 * `ownershipPolicedListShape` above. `deriveViewerRequirement` must derive
 * `{role: {field:'role', value:'moderator'}}` with NO `owner` key, and
 * `tick()` must switch the dispatch persona to that role (not an id) before
 * the persist runs. Investigated live via `runtime-verify --trait
 * MembershipPersistor` / `--trait MembershipRemove --full-walk` against the
 * real `std-realtime-chat.lolo` (2026-09-11): both the data-mutation and
 * crud-delete paths for `ChannelMember` already pass end to end (0 errors)
 * — this test locks that mechanism in as a regression guard rather than
 * fixing a live defect (none reproduced).
 */
function roleOnlyDeletePolicedMembershipShape(): OrbitalSchema {
  const deletePolicy = ['or', ['=', '@user.role', 'moderator'], ['=', '@user.role', 'admin']];
  return {
    name: 'channel-member-role-delete-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'ChannelMembershipOrbital',
        entity: {
          name: 'ChannelMember',
          persistence: 'persistent',
          fields: [
            { name: 'id', type: 'string', required: true },
            { name: 'memberName', type: 'string' },
          ],
          delete_policy: deletePolicy,
        },
        auxiliaryEntities: [
          {
            name: 'OnlineUser',
            persistence: 'persistent',
            identity: true,
            fields: [
              { name: 'id', type: 'string', required: true },
              { name: 'role', type: 'string', values: ['member', 'moderator', 'admin'] },
            ],
          },
        ],
        pages: [],
        traits: [
          {
            name: 'MembershipRemove',
            scope: 'instance',
            linkedEntity: 'ChannelMember',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'confirming' }],
              events: [
                { key: 'INIT', name: 'Init' },
                { key: 'DELETE', name: 'Delete' },
                { key: 'CONFIRM_REMOVE', name: 'Confirm remove' },
              ],
              transitions: [
                {
                  from: 'idle',
                  to: 'confirming',
                  event: 'DELETE',
                  effects: [
                    // Test-only observability hook (see file doc) + a
                    // genuine overlay-form open affordance (C1-V18's gate).
                    ['set', '@entity.lastOpenedBy', '@user.role'],
                    ['render-ui', 'modal', {
                      type: 'stack',
                      children: [{ type: 'button', action: 'CONFIRM_REMOVE', label: 'Remove' }],
                    }],
                  ],
                },
                { from: 'confirming', to: 'idle', event: 'CONFIRM_REMOVE' },
              ],
            },
          },
          {
            name: 'MembershipPersistor',
            scope: 'instance',
            linkedEntity: 'ChannelMember',
            listens: [
              { event: 'CONFIRM_REMOVE', triggers: 'DO_REMOVE', source: { kind: 'trait', trait: 'MembershipRemove' } },
            ],
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [
                { key: 'INIT', name: 'Init' },
                { key: 'DO_REMOVE', name: 'Do remove', payloadSchema: [{ name: 'id', type: 'string' }] },
              ],
              transitions: [
                {
                  from: 'idle',
                  to: 'idle',
                  event: 'DO_REMOVE',
                  effects: [['persist', 'delete', 'ChannelMember', '@payload.id', { emit: { success: 'MEMBERSHIP_CHANGED' } }]],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('planUserCrudFlow viewer switch, role-only OR policy (C1-V19 item 6)', () => {
  it('crud-delete: switches persona to the role literal (never an owner id) and the persist succeeds', async () => {
    const schema = roleOnlyDeletePolicedMembershipShape();
    const steps = planUserCrudFlow(schema);
    const del = steps.find((s) => s.testKind === 'crud-delete');
    expect(del).toBeDefined();
    expect(del?.viewerRequirement).toEqual({ role: { field: 'role', value: 'moderator' } });

    const traits = extractTraitWalkConfigs(schema);
    let capturedPersona: RawUserClaims | null = null;
    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (effects, { persona }) => {
        capturedPersona = persona;
        const traces: EffectTrace[] = [];
        for (const effect of effects) {
          if (!Array.isArray(effect)) continue;
          if (effect[0] === 'set') traces.push({ type: 'set', args: [], status: 'executed' });
        }
        return { effects: traces, emitted: [] };
      },
    });

    const ctx: FakeDriverContext = { outputDir: '', trait: traits.find((t) => t.traitName === 'MembershipRemove')!, runtime };
    await driver.reset(ctx);
    runtime.seed('ChannelMember', [{ id: 'member-1', memberName: 'Ari' }]);

    const initFrame = await tick(driver, ctx, null, {
      from: 'idle',
      event: 'INIT',
      to: 'idle',
      guardCase: null,
      payload: {},
      isRepositioning: false,
      traitName: 'MembershipRemove',
      triggerKind: 'auto-init',
      coverageKey: 'MembershipRemove:auto-init',
    });

    const frame = await tick(driver, ctx, initFrame, del!, undefined, undefined, { id: 'default-viewer', role: '' });

    // No `id` in the captured persona — a role-only policy must never
    // synthesize a spurious owner requirement.
    expect(capturedPersona).toEqual({ id: 'default-viewer', role: 'moderator' });
    expect(runtime.getPersona()).toEqual({ id: 'default-viewer', role: '' });
    expect(frame.errors ?? []).toEqual([]);
    expect(frame.accepted).toBe(true);
  });
});
