/**
 * C1-V15 item A — pipeline end-to-end: `runVerification` dispatches a
 * guard-precondition preamble against a SIBLING trait's own state machine
 * (never the guarded step's own trait) before the guarded `data-mutation`
 * step fires. Mirrors std-helpdesk's `TicketReplyPersistor.DO_CREATE ->
 * idle when @entity.activeTicketId`, established only by
 * `TicketReplyBrowse.SELECT_TICKET` — a plain cold dispatch of `DO_CREATE`
 * would fail the guard and the persist would never run.
 */
import { describe, it, expect } from 'vitest';
import type { EffectTrace, OrbitalSchema, Trait } from '@almadar/core';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';

function helpdeskOrbital(): OrbitalSchema {
  const persistor: Trait = {
    name: 'TicketReplyPersistor',
    scope: 'instance',
    linkedEntity: 'TicketReply',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [
        { key: 'INIT', name: 'Init' },
        { key: 'DO_CREATE', name: 'Do Create', payloadSchema: [{ name: 'data', type: 'object' }] },
      ],
      transitions: [
        { from: 'idle', to: 'idle', event: 'INIT' },
        {
          from: 'idle',
          to: 'idle',
          event: 'DO_CREATE',
          guard: '@entity.activeTicketId',
          effects: [
            ['persist', 'create', 'TicketReply', '@payload.data', { emit: { success: 'REPLY_CREATED' } }],
          ],
        },
      ],
    },
  };

  const browse: Trait = {
    name: 'TicketReplyBrowse',
    scope: 'collection',
    linkedEntity: 'TicketReply',
    listens: [
      { event: 'VIEW', triggers: 'SELECT_TICKET', source: { kind: 'trait', trait: 'TicketThreadRail' }, payloadMapping: { id: '@payload.id' } },
    ],
    stateMachine: {
      states: [{ name: 'browsing', isInitial: true }],
      events: [
        { key: 'INIT', name: 'Init' },
        { key: 'SELECT_TICKET', name: 'Select Ticket', payloadSchema: [{ name: 'id', type: 'string', required: true }] },
      ],
      transitions: [
        { from: 'browsing', to: 'browsing', event: 'INIT' },
        {
          from: 'browsing',
          to: 'browsing',
          event: 'SELECT_TICKET',
          effects: [['set', '@entity.activeTicketId', '@payload.id']],
        },
      ],
    },
  };

  const rail: Trait = {
    name: 'TicketThreadRail',
    scope: 'collection',
    linkedEntity: 'ReplyTicket',
    stateMachine: {
      states: [{ name: 'browsing', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }, { key: 'VIEW', name: 'View' }],
      transitions: [{ from: 'browsing', to: 'browsing', event: 'INIT' }],
    },
  };

  return {
    name: 'helpdesk-sibling-preamble-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'TicketReplyOrbital',
        entity: { name: 'TicketReply', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }, { name: 'activeTicketId', type: 'string' }] },
        auxiliaryEntities: [{ name: 'ReplyTicket', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] }],
        pages: [
          { name: 'RepliesPage', path: '/replies', traits: [{ ref: 'TicketReplyPersistor' }, { ref: 'TicketReplyBrowse' }, { ref: 'TicketThreadRail' }] },
        ],
        traits: [persistor, browse, rail],
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

describe('runVerification — sibling guard-precondition preamble (C1-V15 item A)', () => {
  it('dispatches SELECT_TICKET on the SIBLING trait before DO_CREATE, with the persist outcome success', async () => {
    const orbital = helpdeskOrbital();
    const { extractTraitWalkConfigs } = await import('../../planner/extract-trait-walk-configs.js');
    const traits = extractTraitWalkConfigs(orbital);

    let activeTicketId: string | null = null;

    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (effects, { payload }) => {
        const traces: EffectTrace[] = [];
        for (const effect of effects) {
          if (!Array.isArray(effect)) continue;
          const head = effect[0];
          if (head === 'set' && effect[1] === '@entity.activeTicketId') {
            const ref = effect[2];
            activeTicketId = typeof ref === 'string' && ref.startsWith('@payload.')
              ? String((payload as Record<string, unknown>)[ref.slice('@payload.'.length)])
              : null;
            traces.push({ type: 'set', args: [], status: 'executed' });
            continue;
          }
          if (head === 'persist' && effect[1] === 'create') {
            const guardSatisfied = activeTicketId !== null && activeTicketId.length > 0;
            traces.push({
              type: 'persist',
              entityName: 'TicketReply',
              action: 'create',
              args: [],
              status: guardSatisfied ? 'executed' : 'failed',
              outcome: guardSatisfied ? 'success' : 'denied',
              ...(guardSatisfied && { resultId: 'reply-1' }),
              ...(!guardSatisfied && { error: 'guard @entity.activeTicketId not satisfied' }),
            });
          }
        }
        return { effects: traces, emitted: [] };
      },
    });

    // Seed a ReplyTicket row on every reset — the hermetic per-step reset
    // (`driver.reset`) clears the fake runtime's whole store, so a
    // one-time seed before `runVerification` starts never survives to the
    // step that actually needs it. The entity `bindRowFrom` resolves the
    // SELECT_TICKET preamble's `id` field from (never `TicketReply`).
    const originalReset = driver.reset.bind(driver);
    driver.reset = async (ctx) => {
      await originalReset(ctx);
      runtime.seed('ReplyTicket', [{ id: 'ticket-42' }]);
    };

    const result = await runVerification({
      itemName: 'helpdesk-sibling-preamble-fixture',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: baseOptions,
    });

    const createFrame = result.frames.find(
      (f) => f.cause.event === 'DO_CREATE' && f.cause.testKind === 'data-mutation',
    );
    expect(createFrame).toBeDefined();

    const createIdx = result.frames.indexOf(createFrame!);
    const establishFrame = result.frames[createIdx - 1];

    expect(establishFrame?.cause.event).toBe('SELECT_TICKET');
    expect(establishFrame?.cause.traitName).toBe('TicketReplyBrowse');
    expect(establishFrame?.cause.triggerKind).toBe('reconcile');
    expect(establishFrame?.cause.testKind).toBeUndefined();

    const createTrace = createFrame!.effectResults.find(
      (e) => e.type === 'persist' && e.action === 'create',
    );
    expect(createTrace?.outcome).toBe('success');
    expect(createFrame!.errors ?? []).toEqual([]);
  });
});
