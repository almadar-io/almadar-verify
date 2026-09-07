import { describe, it, expect } from 'vitest';
import type { EffectTrace, OrbitalSchema } from '@almadar/core';
import { planDataMutationTests } from '../plan-data-mutation-tests.js';
import { extractTraitWalkConfigs } from '../extract-trait-walk-configs.js';
import { createFakeDriver, type FakeDriverContext } from '../../driver/impls/fake.js';
import { tick } from '../../driver/tick.js';

/**
 * C1-V8 — R-PERSIST-NO-ROW-KEY-SILENT-SUCCESS, the `from === initialState`
 * gap (docs/Almadar_Runtime_Gaps.md). Mirrors Project Friday's
 * `TaskLifecycle` shape exactly: `CREATE_TASK` is a self-loop AT the
 * trait's own initial state (`backlog`) that binds `@entity.id` and
 * persist-creates the row; `START_TASK` fires from that SAME initial
 * state and persist-updates it. Before this fix, `runVerification`'s own
 * reconcile preamble never runs for `START_TASK` at all (`step.from ===
 * trait.initialState`), so the update fired against a trait instance that
 * never ran `CREATE_TASK` — "persist update resolved no row key".
 */
function taskLifecycleSchema(): OrbitalSchema {
  return {
    name: 'pf-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'TaskOrbital',
        entity: {
          name: 'Task',
          persistence: 'persistent',
          fields: [
            { name: 'id', type: 'string', required: true },
            { name: 'stage', type: 'string' },
          ],
        },
        pages: [],
        traits: [
          {
            name: 'TaskLifecycle',
            scope: 'instance',
            linkedEntity: 'Task',
            stateMachine: {
              states: [{ name: 'backlog', isInitial: true }, { name: 'in_progress' }],
              events: [
                { key: 'INIT', name: 'Init' },
                {
                  key: 'CREATE_TASK',
                  name: 'Create task',
                  payloadSchema: [{ name: 'id', type: 'string', required: true }],
                },
                { key: 'START_TASK', name: 'Start task' },
              ],
              transitions: [
                { from: 'backlog', to: 'backlog', event: 'INIT' },
                {
                  // A literal self-loop at the initial state (not the
                  // `'*'` wildcard form `findRowCreatingSelfLoop` ALSO
                  // accepts) — `FakeRuntime.dispatch`'s transition match
                  // is a literal `from === current` compare with no
                  // wildcard support, unlike a real runtime, so the fixture
                  // uses the concrete-state form to exercise the fake-
                  // driver walk.
                  from: 'backlog',
                  to: 'backlog',
                  event: 'CREATE_TASK',
                  effects: [
                    ['set', '@entity.id', '@payload.id'],
                    ['persist', 'create', 'Task', '@entity'],
                  ],
                },
                {
                  from: 'backlog',
                  to: 'in_progress',
                  event: 'START_TASK',
                  effects: [
                    ['set', '@entity.stage', 'in_progress'],
                    ['persist', 'update', 'Task', '@entity'],
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

/**
 * Fetch/select-bound shape (case 2): `EDIT` binds `@entity.id` from a
 * literal `@payload.id` and `SAVE` persist-updates — both from the
 * trait's own initial state (mirrors `persist-binding.test.ts`'s
 * `editorWithBinding` fixture, collapsed to one state).
 */
function ticketEditorSchema(): OrbitalSchema {
  return {
    name: 'ticket-editor-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'TicketOrbital',
        entity: { name: 'Ticket', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] },
        pages: [],
        traits: [
          {
            name: 'TicketEditor',
            scope: 'collection',
            linkedEntity: 'Ticket',
            stateMachine: {
              states: [{ name: 'browsing', isInitial: true }],
              events: [
                { key: 'INIT', name: 'Init' },
                { key: 'EDIT', name: 'Edit', payloadSchema: [{ name: 'id', type: 'string', required: true }] },
                { key: 'SAVE', name: 'Save' },
              ],
              transitions: [
                { from: 'browsing', to: 'browsing', event: 'INIT' },
                { from: 'browsing', to: 'browsing', event: 'EDIT', effects: [['set', '@entity.id', '@payload.id']] },
                { from: 'browsing', to: 'browsing', event: 'SAVE', effects: [['persist', 'update', 'Ticket', '@entity']] },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('planDataMutationTests — row-establishing preamble (C1-V8)', () => {
  it('plans CREATE_TASK as establishesRow on the START_TASK update step (create-then-update-from-initial-state shape)', () => {
    const steps = planDataMutationTests(taskLifecycleSchema());

    const start = steps.find((s) => s.event === 'START_TASK');
    expect(start).toBeDefined();
    expect(start?.establishesRow).toEqual({
      event: 'CREATE_TASK',
      payload: { id: expect.any(String) },
    });
    expect(start?.unreachableRowReason).toBeUndefined();

    // The creator's OWN create step is unaffected — it must not carry a
    // preamble (it establishes the row itself; `persist.kind === 'create'`
    // is excluded from `planRowEstablishPreamble` entirely).
    const create = steps.find((s) => s.event === 'CREATE_TASK');
    expect(create?.establishesRow).toBeUndefined();
    expect(create?.expectedRowDelta).toEqual({ entityName: 'Task', delta: 1 });
  });

  it('findRowCreatingSelfLoop also matches a `from: \'*\'` wildcard creator (planner-level — FakeRuntime has no wildcard dispatch, so this is checked at the planner, not the fake-driver walk)', () => {
    const schema = taskLifecycleSchema();
    const trait = schema.orbitals[0]!.traits[0];
    if (typeof trait === 'string' || !('stateMachine' in trait) || trait.stateMachine === undefined) {
      throw new Error('fixture trait missing stateMachine');
    }
    const wildcarded: OrbitalSchema = {
      ...schema,
      orbitals: [
        {
          ...schema.orbitals[0]!,
          traits: [
            {
              ...trait,
              stateMachine: {
                ...trait.stateMachine,
                transitions: trait.stateMachine.transitions.map((t) =>
                  t.event === 'CREATE_TASK' ? { ...t, from: '*' } : t,
                ),
              },
            },
          ],
        },
      ],
    };
    const steps = planDataMutationTests(wildcarded);
    const start = steps.find((s) => s.event === 'START_TASK');
    expect(start?.establishesRow?.event).toBe('CREATE_TASK');
    expect(start?.unreachableRowReason).toBeUndefined();
  });

  it('does not plan a preamble when the update step fires from a DIFFERENT (non-initial) state — the existing reconcile mechanism already covers that case', () => {
    const schema = taskLifecycleSchema();
    // Reshape: START_TASK now fires from 'in_progress' (not the initial
    // 'backlog'), so `runVerification`'s own state-topology reconcile
    // preamble runs for it — adding a SECOND preamble here would double-
    // dispatch CREATE_TASK in that reset window.
    const trait = schema.orbitals[0]!.traits[0];
    if (typeof trait === 'string' || !('stateMachine' in trait) || trait.stateMachine === undefined) {
      throw new Error('fixture trait missing stateMachine');
    }
    const reshaped: OrbitalSchema = {
      ...schema,
      orbitals: [
        {
          ...schema.orbitals[0]!,
          traits: [
            {
              ...trait,
              stateMachine: {
                ...trait.stateMachine,
                transitions: trait.stateMachine.transitions.map((t) =>
                  t.event === 'START_TASK' ? { ...t, from: 'in_progress' } : t,
                ),
              },
            },
          ],
        },
      ],
    };
    const steps = planDataMutationTests(reshaped);
    const start = steps.find((s) => s.event === 'START_TASK');
    expect(start?.establishesRow).toBeUndefined();
    expect(start?.unreachableRowReason).toBeUndefined();
  });

  it('plans the fetch/select-bound shape (case 2) with a bindRowFrom, not a literal payload id', () => {
    const steps = planDataMutationTests(ticketEditorSchema());
    const save = steps.find((s) => s.event === 'SAVE');
    expect(save?.establishesRow).toEqual({
      event: 'EDIT',
      payload: { id: expect.any(String) },
      bindRowFrom: { entityName: 'Ticket', payloadField: 'id' },
    });
    expect(save?.unreachableRowReason).toBeUndefined();
  });

  it('bindRowFrom: tick() fills the preamble payload from an existing seeded row at dispatch time', async () => {
    const schema = ticketEditorSchema();
    const steps = planDataMutationTests(schema);
    const save = steps.find((s) => s.event === 'SAVE');
    expect(save).toBeDefined();

    const traits = extractTraitWalkConfigs(schema);
    const dispatchOrder: Array<{ event: string; payload: unknown }> = [];
    let boundEntityId: string | null = null;

    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (effects, { event, payload }) => {
        dispatchOrder.push({ event, payload });
        const traces: EffectTrace[] = [];
        for (const effect of effects) {
          if (!Array.isArray(effect)) continue;
          if (effect[0] === 'set' && effect[1] === '@entity.id') {
            const ref = effect[2];
            boundEntityId = typeof ref === 'string' && ref.startsWith('@payload.')
              ? String(payload[ref.slice('@payload.'.length)])
              : null;
          } else if (effect[0] === 'persist' && effect[1] === 'update') {
            traces.push({
              type: 'persist',
              entityName: 'Ticket',
              action: 'update',
              args: [],
              status: boundEntityId !== null ? 'executed' : 'failed',
              outcome: boundEntityId !== null ? 'success' : 'denied',
              ...(boundEntityId !== null && { resultId: boundEntityId }),
            });
          }
        }
        return { effects: traces, emitted: [] };
      },
    });

    // Seed a REAL pre-existing row (the mock store's deterministic seed,
    // not anything this walk created) and capture it into `prev` via a
    // real auto-init tick, exactly the shape `entitiesBefore` reads from.
    const ctx: FakeDriverContext = { outputDir: '', trait: traits[0]!, runtime };
    await driver.reset(ctx);
    runtime.seed('Ticket', [{ id: 'seed-ticket-1' }]);
    const initFrame = await tick(driver, ctx, null, {
      from: 'browsing',
      event: 'INIT',
      to: 'browsing',
      guardCase: null,
      payload: {},
      isRepositioning: false,
      traitName: 'TicketEditor',
      triggerKind: 'auto-init',
      coverageKey: 'TicketEditor:auto-init',
    });

    const frame = await tick(driver, ctx, initFrame, save!);

    expect(dispatchOrder.map((d) => d.event)).toEqual(['EDIT', 'SAVE']);
    expect(dispatchOrder[0]?.payload).toEqual({ id: 'seed-ticket-1' });
    expect(boundEntityId).toBe('seed-ticket-1');

    const updateTrace = frame.effectResults.find((e) => e.action === 'update');
    expect(updateTrace?.outcome).toBe('success');
    expect(updateTrace?.resultId).toBe('seed-ticket-1');
    expect(frame.errors ?? []).toEqual([]);
  });

  it('bindRowFrom: fails closed with a no-target-row finding (never a silent dispatch) when no seeded row exists at dispatch time', async () => {
    const schema = ticketEditorSchema();
    const steps = planDataMutationTests(schema);
    const save = steps.find((s) => s.event === 'SAVE');
    expect(save).toBeDefined();

    const traits = extractTraitWalkConfigs(schema);
    const dispatchOrder: string[] = [];
    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (_effects, { event }) => {
        dispatchOrder.push(event);
        return { effects: [], emitted: [] };
      },
    });
    const ctx: FakeDriverContext = { outputDir: '', trait: traits[0]!, runtime };
    await driver.reset(ctx);
    // No `runtime.seed(...)` this time — the store has no Ticket row.

    const frame = await tick(driver, ctx, null, save!);

    expect(dispatchOrder).toEqual([]);
    expect(frame.accepted).toBe(false);
    expect(frame.errors).toBeDefined();
    expect(frame.errors?.[0]).toMatch(/no target row/);
  });

  it('fake-driver walk: tick() dispatches the preamble before the update step, in the SAME instance, and the update persist records a real row key', async () => {
    const schema = taskLifecycleSchema();
    const steps = planDataMutationTests(schema);
    const start = steps.find((s) => s.event === 'START_TASK');
    expect(start).toBeDefined();

    const traits = extractTraitWalkConfigs(schema);
    const dispatchOrder: string[] = [];
    let boundEntityId: string | null = null;
    const store = new Set<string>();

    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (effects, { event, payload }) => {
        dispatchOrder.push(event);
        const traces: EffectTrace[] = [];
        for (const effect of effects) {
          if (!Array.isArray(effect)) continue;
          const head = effect[0];
          if (head === 'set' && effect[1] === '@entity.id') {
            const ref = effect[2];
            boundEntityId = typeof ref === 'string' && ref.startsWith('@payload.')
              ? String(payload[ref.slice('@payload.'.length)])
              : null;
            traces.push({ type: 'set', args: [], status: 'executed' });
            continue;
          }
          if (head === 'persist' && effect[1] === 'create') {
            if (boundEntityId !== null) store.add(boundEntityId);
            traces.push({
              type: 'persist',
              entityName: 'Task',
              action: 'create',
              args: [],
              status: boundEntityId !== null ? 'executed' : 'failed',
              outcome: boundEntityId !== null ? 'success' : 'denied',
              ...(boundEntityId !== null && { resultId: boundEntityId }),
              ...(boundEntityId === null && { error: 'resolved no row key' }),
            });
            continue;
          }
          if (head === 'persist' && (effect[1] === 'update' || effect[1] === 'delete')) {
            // The exact defect this fix prevents: a persist update/delete
            // firing against a trait instance whose `@entity.id` was
            // never bound (no CREATE_TASK ran first) resolves no row key.
            const hasRow = boundEntityId !== null && store.has(boundEntityId);
            traces.push({
              type: 'persist',
              entityName: 'Task',
              action: effect[1] === 'update' ? 'update' : 'delete',
              args: [],
              status: hasRow ? 'executed' : 'failed',
              outcome: hasRow ? 'success' : 'denied',
              ...(hasRow && boundEntityId !== null && { resultId: boundEntityId }),
              ...(!hasRow && { error: 'persist update resolved no row key — the id was neither on the row being written nor on the request' }),
            });
          }
        }
        return { effects: traces, emitted: [] };
      },
    });

    const ctx: FakeDriverContext = { outputDir: '', trait: traits[0]!, runtime };
    await driver.reset(ctx);

    const frame = await tick(driver, ctx, null, start!);

    expect(dispatchOrder).toEqual(['CREATE_TASK', 'START_TASK']);

    const updateTrace = frame.effectResults.find(
      (e) => e.type === 'persist' && e.action === 'update',
    );
    expect(updateTrace?.outcome).toBe('success');
    expect(updateTrace?.resultId).toBeDefined();
    expect(updateTrace?.resultId).toBe(boundEntityId);
    expect(frame.errors ?? []).toEqual([]);

    // The preamble's own CREATE effect is NOT in this frame's
    // `effectResults` — `snapshot()` reads only the most recent
    // dispatch's trace (overwritten by the update's own dispatch), so
    // the preamble is never scored as this frame's data-mutation verdict.
    expect(frame.effectResults.some((e) => e.action === 'create')).toBe(false);
  });

  it('yields an unreachableRowReason finding (never a silent dispatch) when the trait never binds the row at all', async () => {
    const noBinding: OrbitalSchema = {
      name: 'pf-fixture-no-binding',
      designTokens: {},
      customPatterns: {},
      orbitals: [
        {
          name: 'TaskOrbital',
          entity: { name: 'Task', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] },
          pages: [],
          traits: [
            {
              name: 'TaskLifecycleUnbound',
              scope: 'instance',
              linkedEntity: 'Task',
              stateMachine: {
                states: [{ name: 'backlog', isInitial: true }, { name: 'in_progress' }],
                events: [
                  { key: 'INIT', name: 'Init' },
                  { key: 'START_TASK', name: 'Start task' },
                ],
                transitions: [
                  { from: 'backlog', to: 'backlog', event: 'INIT' },
                  {
                    from: 'backlog',
                    to: 'in_progress',
                    event: 'START_TASK',
                    effects: [['persist', 'update', 'Task', '@entity']],
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const steps = planDataMutationTests(noBinding);
    const start = steps.find((s) => s.event === 'START_TASK');
    expect(start?.establishesRow).toBeUndefined();
    expect(start?.unreachableRowReason).toMatch(/no target row/);

    const traits = extractTraitWalkConfigs(noBinding);
    const dispatchOrder: string[] = [];
    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (_effects, { event }) => {
        dispatchOrder.push(event);
        return { effects: [], emitted: [] };
      },
    });
    const ctx: FakeDriverContext = { outputDir: '', trait: traits[0]!, runtime };
    await driver.reset(ctx);

    const frame = await tick(driver, ctx, null, start!);

    // Never a silent bus dispatch: the kernel must not even attempt to
    // deliver a write it statically knows cannot succeed.
    expect(dispatchOrder).toEqual([]);
    expect(frame.accepted).toBe(false);
    expect(frame.errors).toEqual([start!.unreachableRowReason]);
  });
});

/**
 * C1-V14 (F4) — the `fromState !== initialState` generalization of C1-V8.
 * `MOVE_STAGE` fires from `in_progress` (not the trait's initial
 * `backlog`), so `runVerification`'s reconcile preamble DOES run for it —
 * but its `planReplayTo` path (`START_TASK: backlog -> in_progress`) never
 * traverses `CREATE_TASK` (a self-loop AT the initial state, never a hop
 * on a BFS path to a DIFFERENT state reached FROM it), so the row is
 * still never created before `MOVE_STAGE` fires.
 */
function taskLifecycleWithMoveStageSchema(): OrbitalSchema {
  const schema = taskLifecycleSchema();
  const trait = schema.orbitals[0]!.traits[0];
  if (typeof trait === 'string' || !('stateMachine' in trait) || trait.stateMachine === undefined) {
    throw new Error('fixture trait missing stateMachine');
  }
  return {
    ...schema,
    orbitals: [
      {
        ...schema.orbitals[0]!,
        traits: [
          {
            ...trait,
            stateMachine: {
              ...trait.stateMachine,
              transitions: [
                ...trait.stateMachine.transitions,
                {
                  from: 'in_progress',
                  to: 'in_progress',
                  event: 'MOVE_STAGE',
                  effects: [
                    ['set', '@entity.stage', 'blocked'],
                    ['persist', 'update', 'Task', '@entity'],
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

/**
 * A trait whose replay path to the update step's `from` DOES traverse an
 * id-binding hop (`OPEN {id}` sets `@entity.id` from `@payload.id`) — the
 * reconcile preamble's OWN dispatch of that hop already establishes the
 * row (`seedEntityIdIfBinding`), so no `establishesRow` preamble is
 * needed on top of it.
 */
function openThenUpdateSchema(): OrbitalSchema {
  return {
    name: 'open-then-update-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'TaskOrbital',
        entity: {
          name: 'Task',
          persistence: 'persistent',
          fields: [
            { name: 'id', type: 'string', required: true },
            { name: 'stage', type: 'string' },
          ],
        },
        pages: [],
        traits: [
          {
            name: 'TaskOpenThenUpdate',
            scope: 'instance',
            linkedEntity: 'Task',
            stateMachine: {
              states: [{ name: 'backlog', isInitial: true }, { name: 'open' }],
              events: [
                { key: 'INIT', name: 'Init' },
                {
                  key: 'OPEN',
                  name: 'Open',
                  payloadSchema: [{ name: 'id', type: 'string', required: true }],
                },
                { key: 'UPDATE', name: 'Update' },
              ],
              transitions: [
                { from: 'backlog', to: 'backlog', event: 'INIT' },
                {
                  from: 'backlog',
                  to: 'open',
                  event: 'OPEN',
                  effects: [['set', '@entity.id', '@payload.id']],
                },
                {
                  from: 'open',
                  to: 'open',
                  event: 'UPDATE',
                  effects: [['persist', 'update', 'Task', '@entity']],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('planDataMutationTests — beforeReplay generalization (C1-V14, F4)', () => {
  it('plans CREATE_TASK as a beforeReplay establishesRow preamble on MOVE_STAGE (fromState !== initialState, replay path never traverses the establisher)', () => {
    const steps = planDataMutationTests(taskLifecycleWithMoveStageSchema());

    const moveStage = steps.find((s) => s.event === 'MOVE_STAGE');
    expect(moveStage).toBeDefined();
    expect(moveStage?.establishesRow).toEqual({
      event: 'CREATE_TASK',
      payload: { id: expect.any(String) },
      beforeReplay: true,
    });
    expect(moveStage?.unreachableRowReason).toBeUndefined();

    // START_TASK (fromState === initialState) still gets the ORIGINAL
    // C1-V8 shape — no `beforeReplay` — unaffected by this generalization.
    const start = steps.find((s) => s.event === 'START_TASK');
    expect(start?.establishesRow).toEqual({ event: 'CREATE_TASK', payload: { id: expect.any(String) } });
  });

  it('does not plan a preamble when the replay path to fromState already traverses an id-binding hop', () => {
    const steps = planDataMutationTests(openThenUpdateSchema());

    const update = steps.find((s) => s.event === 'UPDATE');
    expect(update).toBeDefined();
    expect(update?.establishesRow).toBeUndefined();
    expect(update?.unreachableRowReason).toBeUndefined();
  });
});
