import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, Trait } from '@almadar/core';
import {
  collectEntityIdBindingTransitions,
  collectPersistWriteTransitions,
  findPersistKind,
  traitHasEntityIdBinding,
} from '../persist-binding.js';

/** Mirrors `std-approval-gate`/`std-mod-queue` shape: EDIT binds `@entity.id`
 *  from the payload, SAVE persists the whole bound `@entity`. */
const editorWithBinding: Trait = {
  name: 'TicketEditor',
  scope: 'collection',
  linkedEntity: 'Ticket',
  stateMachine: {
    states: [{ name: 'browsing', isInitial: true }, { name: 'editing' }],
    events: [
      { key: 'INIT', name: 'Init' },
      { key: 'EDIT', name: 'Edit', payloadSchema: [{ name: 'id', type: 'string', required: true }] },
      { key: 'SAVE', name: 'Save' },
    ],
    transitions: [
      { from: 'browsing', to: 'browsing', event: 'INIT' },
      {
        from: 'browsing',
        to: 'editing',
        event: 'EDIT',
        effects: [['set', '@entity.id', '@payload.id']],
      },
      {
        from: 'editing',
        to: 'browsing',
        event: 'SAVE',
        effects: [['persist', 'update', 'Ticket', '@entity']],
      },
    ],
  },
};

/** Same persist shape, but nothing anywhere sets `@entity.id` — the
 *  ORB_BINDING_PERSIST_ROW_ID_NEVER_SET condition. */
const editorWithoutBinding: Trait = {
  ...editorWithBinding,
  name: 'TicketEditorUnbound',
  stateMachine: {
    ...editorWithBinding.stateMachine!,
    transitions: [
      { from: 'browsing', to: 'browsing', event: 'INIT' },
      { from: 'browsing', to: 'editing', event: 'EDIT' },
      {
        from: 'editing',
        to: 'browsing',
        event: 'SAVE',
        effects: [['persist', 'update', 'Ticket', '@entity']],
      },
    ],
  },
};

describe('findPersistKind', () => {
  it('detects create/update/delete and the emit.success event', () => {
    expect(findPersistKind([['persist', 'create', 'Ticket', {}]])).toEqual({ kind: 'create', entity: 'Ticket' });
    expect(
      findPersistKind([['persist', 'update', 'Ticket', '@entity', { emit: { success: 'SAVED' } }]]),
    ).toEqual({ kind: 'update', entity: 'Ticket', successEvent: 'SAVED' });
  });

  it('returns null when no persist effect is present', () => {
    expect(findPersistKind([['fetch', 'Ticket', {}]])).toBeNull();
  });
});

describe('traitHasEntityIdBinding', () => {
  it('true when a transition sets @entity.id', () => {
    expect(traitHasEntityIdBinding(editorWithBinding)).toBe(true);
  });

  it('false when nothing anywhere sets @entity.id — the static-validator condition', () => {
    expect(traitHasEntityIdBinding(editorWithoutBinding)).toBe(false);
  });

  it('false for a trait with no state machine', () => {
    expect(traitHasEntityIdBinding({ name: 'NoSm', scope: 'collection' })).toBe(false);
  });
});

describe('collectEntityIdBindingTransitions', () => {
  it('maps the binding transition to its @payload path', () => {
    const bindings = collectEntityIdBindingTransitions(editorWithBinding);
    expect(bindings.get('browsing+EDIT->editing')).toEqual({ payloadPath: 'id' });
    expect(bindings.size).toBe(1);
  });

  it('empty when the trait has no id-binding transition', () => {
    expect(collectEntityIdBindingTransitions(editorWithoutBinding).size).toBe(0);
  });

  it('skips a set whose value is not a literal @payload.<path> binding', () => {
    const computed: Trait = {
      ...editorWithBinding,
      stateMachine: {
        ...editorWithBinding.stateMachine!,
        transitions: [
          {
            from: 'browsing',
            to: 'editing',
            event: 'EDIT',
            effects: [['set', '@entity.id', ['concat', '@payload.id', '-x']]],
          },
        ],
      },
    };
    // Not seedable (no single payload slot to inject into) — but still
    // counts toward the broad any-binding guard.
    expect(collectEntityIdBindingTransitions(computed).size).toBe(0);
    expect(traitHasEntityIdBinding(computed)).toBe(true);
  });
});

describe('collectPersistWriteTransitions', () => {
  it('keys persist writes by traitName:from+event->to', () => {
    const orbital: OrbitalSchema = {
      name: 'fixture',
      designTokens: {},
      customPatterns: {},
      orbitals: [
        {
          name: 'TicketOrbital',
          entity: { name: 'Ticket', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
          pages: [],
          traits: [editorWithBinding],
        },
      ],
    };
    const writes = collectPersistWriteTransitions(orbital);
    expect(writes.get('TicketEditor:editing+SAVE->browsing')).toEqual({ kind: 'update', entity: 'Ticket' });
  });
});
