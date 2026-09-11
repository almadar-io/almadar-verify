/**
 * C1-V15 item C: `planUserCrudFlow` attaches a `deleteEstablishFallback`
 * to a `crud-delete` step ONLY when the entity has a restrict-rule
 * self-relation (`selfRelationFieldNames` non-empty — the ONLY shape that
 * can legitimately run out of unreferenced rows on a real seed) AND the
 * orbital declares a `create` for the same entity. Neither condition →
 * `tick()` keeps today's plain `no-target-row` behavior unchanged.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, OrbitalEntity, Trait } from '@almadar/core';
import { planUserCrudFlow } from '../plan-user-crud-flow.js';

function createTrait(): Trait {
  return {
    name: 'NoteCreate',
    scope: 'instance',
    linkedEntity: 'Note',
    stateMachine: {
      states: [{ name: 'closed', isInitial: true }, { name: 'open' }],
      events: [
        { key: 'INIT', name: 'Init' },
        { key: 'CREATE', name: 'Create' },
        { key: 'NOTE_CREATED', name: 'Save', payloadSchema: [{ name: 'data', type: 'object', required: true }] },
      ],
      transitions: [
        {
          from: 'closed',
          to: 'open',
          event: 'CREATE',
          effects: [['render-ui', 'main', { type: 'modal', children: [{ type: 'form-section', fields: ['title'], submitEvent: 'NOTE_CREATED' }] }]],
        },
        { from: 'open', to: 'closed', event: 'NOTE_CREATED' },
      ],
    },
  };
}

function deleteTrait(): Trait {
  return {
    name: 'NoteDelete',
    scope: 'instance',
    linkedEntity: 'Note',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }, { name: 'confirming' }],
      events: [{ key: 'INIT', name: 'Init' }, { key: 'DELETE', name: 'Delete' }, { key: 'CONFIRM_DELETE', name: 'Confirm' }],
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
  };
}

function persistorTrait(): Trait {
  return {
    name: 'NotePersistor',
    scope: 'instance',
    linkedEntity: 'Note',
    listens: [
      { event: 'NOTE_CREATED', triggers: 'DO_CREATE', source: { kind: 'trait', trait: 'NoteCreate' } },
      { event: 'CONFIRM_DELETE', triggers: 'DO_DELETE', source: { kind: 'trait', trait: 'NoteDelete' } },
    ],
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }, { key: 'DO_CREATE', name: 'Do Create' }, { key: 'DO_DELETE', name: 'Do Delete' }],
      transitions: [
        {
          from: 'idle', to: 'idle', event: 'DO_CREATE',
          effects: [['persist', 'create', 'Note', { data: '@payload.data', emit: { success: 'ITEM_CREATED' } }]],
        },
        {
          from: 'idle', to: 'idle', event: 'DO_DELETE',
          effects: [['persist', 'delete', 'Note', { id: '@payload.id', emit: { success: 'ITEM_DELETED' } }]],
        },
      ],
    },
  };
}

function schemaWith(entity: OrbitalEntity): OrbitalSchema {
  return {
    name: 'note-delete-fallback-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [{ name: 'NoteOrbital', entity, pages: [], traits: [createTrait(), deleteTrait(), persistorTrait()] }],
  };
}

const plainEntity: OrbitalEntity = {
  name: 'Note',
  persistence: 'persistent',
  fields: [{ name: 'id', type: 'string', required: true }, { name: 'title', type: 'string' }],
};

const selfRelatingEntity: OrbitalEntity = {
  name: 'Note',
  persistence: 'persistent',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'title', type: 'string' },
    { name: 'parentId', type: 'relation', relation: { entity: 'Note', cardinality: 'one' } },
  ],
};

describe('planUserCrudFlow — deleteEstablishFallback (C1-V15 item C)', () => {
  it('attaches no fallback when the entity has no self-relation', () => {
    const steps = planUserCrudFlow(schemaWith(plainEntity));
    const del = steps.find((s) => s.testKind === 'crud-delete');
    expect(del).toBeDefined();
    expect(del?.deleteEstablishFallback).toBeUndefined();
  });

  it('attaches the declared create flow as a fallback when the entity self-relates and a create exists', () => {
    const steps = planUserCrudFlow(schemaWith(selfRelatingEntity));
    const del = steps.find((s) => s.testKind === 'crud-delete');
    expect(del).toBeDefined();
    expect(del?.deleteEstablishFallback).toBeDefined();
    expect(del?.deleteEstablishFallback?.event).toBe('DO_CREATE');
    expect(del?.deleteEstablishFallback?.traitName).toBe('NotePersistor');
  });
});
