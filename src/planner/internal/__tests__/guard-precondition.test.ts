import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, Trait, Transition } from '@almadar/core';
import { planGuardPreconditionPreamble } from '../guard-precondition.js';

/**
 * C1-V15 item A — mirrors std-helpdesk's real shape exactly:
 * `TicketReplyPersistor.DO_CREATE -> idle when @entity.activeTicketId`
 * reads a field ONLY `TicketReplyBrowse.SELECT_TICKET` (a SIBLING trait,
 * self-loop at ITS OWN initial state `browsing`) ever sets — and
 * `SELECT_TICKET.id` is bound via a `listens` fan-out from
 * `TicketThreadRail.VIEW` (`linkedEntity: 'ReplyTicket'`), so the row to
 * bind it from is `ReplyTicket`, never `TicketReply`.
 */
function helpdeskSchema(withSetter: boolean): { schema: OrbitalSchema; persistor: Trait } {
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
        ...(withSetter
          ? [{
              from: 'browsing',
              to: 'browsing',
              event: 'SELECT_TICKET',
              effects: [['set', '@entity.activeTicketId', '@payload.id']],
            } satisfies Transition]
          : []),
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

  const schema: OrbitalSchema = {
    name: 'helpdesk-guard-precondition-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'TicketReplyOrbital',
        entity: { name: 'TicketReply', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }, { name: 'activeTicketId', type: 'string' }] },
        auxiliaryEntities: [{ name: 'ReplyTicket', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] }],
        pages: [],
        traits: [persistor, browse, rail],
      },
    ],
  };
  return { schema, persistor };
}

describe('planGuardPreconditionPreamble (C1-V15 item A)', () => {
  it('attaches the sibling SELECT_TICKET preamble when the setter exists', () => {
    const { schema, persistor } = helpdeskSchema(true);
    const doCreate = persistor.stateMachine!.transitions.find((t) => t.event === 'DO_CREATE')!;

    const result = planGuardPreconditionPreamble(schema, persistor, doCreate, 'idle', {});

    expect(result.guardPreconditionUnreachable).toBeUndefined();
    expect(result.establishesRow).toBeDefined();
    expect(result.establishesRow?.event).toBe('SELECT_TICKET');
    expect(result.establishesRow?.traitName).toBe('TicketReplyBrowse');
    expect(result.establishesRow?.beforeReplay).toBe(true);
    // The `id` field is bound from `ReplyTicket` (TicketThreadRail's own
    // linkedEntity) — resolved from the listens payloadMapping, never
    // guessed from the field's name.
    expect(result.establishesRow?.bindRowFrom).toEqual({ entityName: 'ReplyTicket', payloadField: 'id' });
  });

  it('reports guard-precondition-unreachable when no transition anywhere sets the field', () => {
    const { schema, persistor } = helpdeskSchema(false);
    const doCreate = persistor.stateMachine!.transitions.find((t) => t.event === 'DO_CREATE')!;

    const result = planGuardPreconditionPreamble(schema, persistor, doCreate, 'idle', {});

    expect(result.establishesRow).toBeUndefined();
    expect(result.guardPreconditionUnreachable).toBeDefined();
    expect(result.guardPreconditionUnreachable).toContain('guard-precondition-unreachable');
    expect(result.guardPreconditionUnreachable).toContain('activeTicketId');
  });

  it('is a no-op for an unguarded transition', () => {
    const { schema, persistor } = helpdeskSchema(true);
    const init = persistor.stateMachine!.transitions.find((t) => t.event === 'INIT')!;

    const result = planGuardPreconditionPreamble(schema, persistor, init, 'idle', {});
    expect(result).toEqual({});
  });
});
