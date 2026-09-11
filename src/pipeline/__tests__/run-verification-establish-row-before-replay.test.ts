/**
 * C1-V14 (F4) — pipeline end-to-end: `runVerification` dispatches a
 * `beforeReplay` `establishesRow` preamble itself, as its own reconcile
 * frame, right after `driver.reset(ctx)` and BEFORE walking the replay
 * hops that put the trait in the real step's `from` state.
 *
 * Mirrors Project Friday's `TaskLifecycle` shape exactly: `CREATE_TASK` is
 * a self-loop AT the trait's own initial state (`backlog`) that binds
 * `@entity.id` and persist-creates the row; `START_TASK` (backlog ->
 * in_progress) is a plain update with no id-binding; `MOVE_STAGE`
 * (in_progress -> in_progress) persist-updates the row. `MOVE_STAGE`'s
 * `from` differs from the initial state, so the pipeline's own reconcile
 * preamble DOES run for it (`planReplayTo` walks `START_TASK`) — but that
 * replay path never traverses `CREATE_TASK` (a BFS shortest path never
 * revisits its own source state), so before this fix the row was never
 * created and `MOVE_STAGE`'s persist resolved no row key.
 */

import { describe, it, expect } from 'vitest';
import type { EffectTrace, OrbitalSchema, Trait } from '@almadar/core';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';

const taskLifecycleTrait: Trait = {
  name: 'TaskLifecycle',
  scope: 'instance',
  linkedEntity: 'Task',
  stateMachine: {
    states: [{ name: 'backlog', isInitial: true }, { name: 'in_progress' }],
    events: [
      { key: 'INIT', name: 'Init' },
      { key: 'CREATE_TASK', name: 'Create task', payloadSchema: [{ name: 'id', type: 'string', required: true }] },
      { key: 'START_TASK', name: 'Start task' },
      { key: 'MOVE_STAGE', name: 'Move stage' },
    ],
    transitions: [
      { from: 'backlog', to: 'backlog', event: 'INIT' },
      {
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
        effects: [['set', '@entity.stage', 'in_progress']],
      },
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
};

function orbitalFor(trait: Trait): OrbitalSchema {
  return {
    name: 'pf-establish-before-replay-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'TaskOrbital',
        entity: {
          name: 'Task',
          persistence: 'runtime',
          fields: [
            { name: 'id', type: 'string', required: true },
            { name: 'stage', type: 'string' },
          ],
        },
        pages: [{ name: 'TaskPage', path: '/tasks', traits: [{ ref: trait.name }] }],
        traits: [trait],
      },
    ],
  };
}

const baseOptions = {
  enableInteractionTests: false,
  enableContractEvents: false,
  enableDataMutationTests: true,
  enableClickPathSamples: false,
  enablePortalPerStep: false,
  enableUserCrudFlow: false,
  enableTickTests: false,
  enableEmitSweep: false,
  log: () => {},
};

/**
 * C1-V16 — pipeline end-to-end: a guard-precondition preamble
 * (`guard-precondition.ts`'s `establishAtState`) whose selected setter arm
 * only exists PAST the establishing trait's own initial state. Mirrors
 * std-thread's real shape: `ChannelThread` boots at `loading`; `browsing`
 * is reached via a real dispatchable hop (`LOAD`); `EDIT_REPLY` (the
 * setter `SUBMIT_REPLY`'s guard needs) is a self-loop declared ONLY at
 * `browsing`, with no arm at `loading`. Before this fix the preamble fired
 * at the trait's raw initial state (`loading`), where `EDIT_REPLY` has no
 * arm — a silent no-op that left `replyDraft` empty and the guard failing
 * every time.
 */
describe('runVerification — guard-precondition preamble replays to a non-initial establishAtState (C1-V16)', () => {
  it('replays loading->browsing before dispatching EDIT_REPLY, then SUBMIT_REPLY succeeds', async () => {
    const thread: Trait = {
      name: 'ChannelThread',
      scope: 'instance',
      linkedEntity: 'ChatMessage',
      stateMachine: {
        states: [{ name: 'loading', isInitial: true }, { name: 'browsing' }],
        events: [
          { key: 'INIT', name: 'Init' },
          { key: 'LOAD', name: 'Load' },
          { key: 'EDIT_REPLY', name: 'Edit Reply', payloadSchema: [{ name: 'value', type: 'string', required: true }] },
          { key: 'SUBMIT_REPLY', name: 'Submit Reply', payloadSchema: [{ name: 'data', type: 'string' }] },
        ],
        transitions: [
          { from: 'loading', to: 'loading', event: 'INIT' },
          { from: 'loading', to: 'browsing', event: 'LOAD' },
          {
            from: 'browsing',
            to: 'browsing',
            event: 'EDIT_REPLY',
            effects: [['set', '@entity.replyDraft', '@payload.value']],
          },
          {
            from: 'browsing',
            to: 'browsing',
            event: 'SUBMIT_REPLY',
            guard: '@entity.replyDraft',
            effects: [
              ['persist', 'update', 'ChatMessage', '@payload.data', { emit: { success: 'SubmitReplyDone' } }],
            ],
          },
        ],
      },
    };

    const orbital: OrbitalSchema = {
      name: 'thread-establish-at-state-fixture',
      designTokens: {},
      customPatterns: {},
      orbitals: [
        {
          name: 'ChannelOrbital',
          entity: {
            name: 'ChatMessage',
            persistence: 'persistent',
            fields: [
              { name: 'id', type: 'string', required: true },
              { name: 'replyDraft', type: 'string' },
            ],
          },
          pages: [{ name: 'ThreadPage', path: '/thread', traits: [{ ref: thread.name }] }],
          traits: [thread],
        },
      ],
    };

    const { extractTraitWalkConfigs } = await import('../../planner/extract-trait-walk-configs.js');
    const traits = extractTraitWalkConfigs(orbital);

    let replyDraft = '';

    const { driver, runtime } = createFakeDriver(traits, {
      evaluateGuard: () => replyDraft !== '',
      executeEffects: (effects, { payload }) => {
        const traces: EffectTrace[] = [];
        for (const effect of effects) {
          if (!Array.isArray(effect)) continue;
          const head = effect[0];
          if (head === 'set' && effect[1] === '@entity.replyDraft') {
            const ref = effect[2];
            replyDraft = typeof ref === 'string' && ref.startsWith('@payload.')
              ? String(payload[ref.slice('@payload.'.length)] ?? '')
              : '';
            traces.push({ type: 'set', args: [], status: 'executed' });
            continue;
          }
          if (head === 'persist' && effect[1] === 'update') {
            traces.push({
              type: 'persist',
              entityName: 'ChatMessage',
              action: 'update',
              args: [],
              status: 'executed',
              outcome: 'success',
              resultId: 'msg-1',
            });
          }
        }
        return { effects: traces, emitted: [] };
      },
    });

    // Seed a ChatMessage row on every reset — the hermetic per-step reset
    // clears the fake runtime's whole store, so a one-time seed before
    // `runVerification` starts never survives to the step that needs it.
    const originalReset = driver.reset.bind(driver);
    driver.reset = async (ctx) => {
      await originalReset(ctx);
      runtime.seed('ChatMessage', [{ id: 'msg-1', replyDraft: '' }]);
    };

    const result = await runVerification({
      itemName: 'thread-establish-at-state-fixture',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: baseOptions,
    });

    const submitFrame = result.frames.find(
      (f) => f.cause.event === 'SUBMIT_REPLY' && f.cause.testKind === 'data-mutation',
    );
    expect(submitFrame).toBeDefined();

    const establishFrame = result.frames.find(
      (f) => f.cause.event === 'EDIT_REPLY' && f.cause.coverageKey?.includes('[establish-row]'),
    );
    expect(establishFrame).toBeDefined();
    // The fix: the preamble dispatches AT `browsing`, not the trait's raw
    // initial state `loading` — the only state `EDIT_REPLY` has an arm at.
    expect(establishFrame?.cause.from).toBe('browsing');

    const loadReconcileFrame = result.frames.find(
      (f) => f.cause.event === 'LOAD' && f.cause.coverageKey?.includes('[establish-reconcile]'),
    );
    expect(loadReconcileFrame).toBeDefined();
    expect(result.frames.indexOf(loadReconcileFrame!)).toBeLessThan(result.frames.indexOf(establishFrame!));

    const persistTrace = submitFrame!.effectResults.find((e) => e.type === 'persist' && e.action === 'update');
    expect(persistTrace?.outcome).toBe('success');
    expect(submitFrame!.errors ?? []).toEqual([]);
  });
});

describe('runVerification — beforeReplay establish-row preamble (C1-V14, F4)', () => {
  it('dispatches CREATE_TASK (establish) -> START_TASK (reconcile) -> MOVE_STAGE (step) inside one reset window, with a real bound row id', async () => {
    const orbital = orbitalFor(taskLifecycleTrait);
    const { extractTraitWalkConfigs } = await import('../../planner/extract-trait-walk-configs.js');
    const traits = extractTraitWalkConfigs(orbital);

    let boundEntityId: string | null = null;
    const store = new Set<string>();

    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (effects, { event, payload }) => {
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
          if (head === 'set') {
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
          if (head === 'persist' && effect[1] === 'update') {
            const hasRow = boundEntityId !== null && store.has(boundEntityId);
            traces.push({
              type: 'persist',
              entityName: 'Task',
              action: 'update',
              args: [],
              status: hasRow ? 'executed' : 'failed',
              outcome: hasRow ? 'success' : 'denied',
              ...(hasRow && boundEntityId !== null && { resultId: boundEntityId }),
              ...(!hasRow && { error: 'persist update resolved no row key' }),
            });
          }
        }
        return { effects: traces, emitted: [] };
      },
    });

    const result = await runVerification({
      itemName: 'pf-establish-before-replay-fixture',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: baseOptions,
    });

    const moveStageFrame = result.frames.find(
      (f) => f.cause.event === 'MOVE_STAGE' && f.cause.testKind === 'data-mutation',
    );
    expect(moveStageFrame).toBeDefined();

    const moveStageIdx = result.frames.indexOf(moveStageFrame!);
    const startTaskFrame = result.frames[moveStageIdx - 1];
    const establishFrame = result.frames[moveStageIdx - 2];

    // The establish-row frame precedes the reconcile hop, which precedes
    // the real step — one reset window, dispatched in this exact order.
    expect(establishFrame?.cause.event).toBe('CREATE_TASK');
    expect(establishFrame?.cause.triggerKind).toBe('reconcile');
    expect(establishFrame?.cause.testKind).toBeUndefined();
    expect(establishFrame?.cause.coverageKey).toContain('[establish-row]');

    expect(startTaskFrame?.cause.event).toBe('START_TASK');
    expect(startTaskFrame?.cause.triggerKind).toBe('reconcile');

    // The real step's persist trace carries the row id CREATE_TASK bound —
    // the defect this fix prevents ("persist update resolved no row key").
    const updateTrace = moveStageFrame!.effectResults.find(
      (e) => e.type === 'persist' && e.action === 'update',
    );
    expect(updateTrace?.outcome).toBe('success');
    expect(updateTrace?.resultId).toBeDefined();
    expect(moveStageFrame!.errors ?? []).toEqual([]);
  });
});
