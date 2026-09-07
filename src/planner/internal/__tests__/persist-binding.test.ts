import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrbitalSchema, Trait } from '@almadar/core';
import type { Effect, PayloadField } from '@almadar/core';
import {
  collectEntityIdBindingTransitions,
  collectPersistWriteTransitions,
  findPersistKind,
  findPersistPayloadBinding,
  findPersistWholeRowField,
  isWholeRowField,
  traitHasEntityIdBinding,
} from '../persist-binding.js';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');

/** `preprocessSchema` (`@almadar/runtime`'s `UsesIntegration.ts`) wraps a
 * resolved trait carrying `config`/`linkedEntity` into `{ref, config,
 * linkedEntity, _resolved: Trait}` rather than the bare inline shape —
 * unwrap it, same convention as the runtime package's own corpus-parity
 * tests. */
function asResolvedTrait(t: unknown): Trait | undefined {
  if (typeof t !== 'object' || t === null) return undefined;
  if ('stateMachine' in t) return t as Trait;
  if ('_resolved' in t && (t as { _resolved?: unknown })._resolved) return (t as { _resolved: Trait })._resolved;
  return undefined;
}

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

describe('isWholeRowField', () => {
  it('true when the field\'s entity marker names the target entity', () => {
    expect(isWholeRowField({ entity: 'Note' }, 'Note')).toBe(true);
  });

  it('false when the marker names a different entity, or is absent', () => {
    expect(isWholeRowField({ entity: 'Ticket' }, 'Note')).toBe(false);
    expect(isWholeRowField({}, 'Note')).toBe(false);
  });
});

describe('findPersistWholeRowField', () => {
  /** Mirrors `NoteDelete.DELETE`'s real resolved shape (both the compiled
   *  and runtime paths stamp this today, C1-J3 item B — verified against
   *  `std-notes.orb`): the field flattens the bound entity and carries the
   *  `entity` marker, confirmed via {@link isWholeRowField} against the
   *  persist effect's own declared entity argument. */
  const wholeRowSchema: ReadonlyArray<PayloadField> = [
    {
      name: 'data',
      type: 'object',
      required: true,
      entity: 'Note',
      properties: [
        { name: 'id', type: 'string', required: true },
        { name: 'title', type: 'string', required: true },
      ],
    },
  ];

  it('finds the field a persist update effect writes the whole row from', () => {
    const effects: ReadonlyArray<Effect> = [
      ['persist', 'update', 'Note', '@payload.data', { emit: { success: 'NOTE_UPDATED' } }],
    ];
    expect(findPersistWholeRowField(effects, wholeRowSchema)).toBe('data');
  });

  it('finds it for a persist create effect too', () => {
    const effects: ReadonlyArray<Effect> = [
      ['persist', 'create', 'Note', '@payload.data', { emit: { success: 'NOTE_CREATED' } }],
    ];
    expect(findPersistWholeRowField(effects, wholeRowSchema)).toBe('data');
  });

  it('returns null for a persist delete effect (no row to write)', () => {
    const effects: ReadonlyArray<Effect> = [['persist', 'delete', 'Note', '@payload.id']];
    expect(findPersistWholeRowField(effects, wholeRowSchema)).toBeNull();
  });

  it('returns null for a partial-update literal object ref (not a bare @payload.<field> pointer)', () => {
    const effects: ReadonlyArray<Effect> = [
      [
        'persist',
        'update',
        'Note',
        { id: '@payload.id', content: '@payload.content' },
        { emit: { success: 'NOTE_CONTENT_SAVED' } },
      ],
    ];
    expect(findPersistWholeRowField(effects, wholeRowSchema)).toBeNull();
  });

  it('returns null when the referenced field is scalar-typed and carries no entity marker (a bare id ref)', () => {
    const scalarSchema: ReadonlyArray<PayloadField> = [{ name: 'id', type: 'string', required: true }];
    const effects: ReadonlyArray<Effect> = [
      ['persist', 'update', 'Note', '@payload.id', { emit: { success: 'NOTE_UPDATED' } }],
    ];
    expect(findPersistWholeRowField(effects, scalarSchema)).toBeNull();
  });

  it('returns null when the field is object-typed but its entity marker names a DIFFERENT entity than the persist declares', () => {
    const mismatchedSchema: ReadonlyArray<PayloadField> = [
      { name: 'data', type: 'object', entity: 'OtherEntity', properties: [{ name: 'id', type: 'string' }] },
    ];
    const effects: ReadonlyArray<Effect> = [
      ['persist', 'update', 'Note', '@payload.data', { emit: { success: 'NOTE_UPDATED' } }],
    ];
    expect(findPersistWholeRowField(effects, mismatchedSchema)).toBeNull();
  });

  it('falls back to the `type` check on an UN-resolved schema (no entity marker at all) — preserves the original, marker-independent contract (C1-J3 item B)', () => {
    // Mirrors `probe-listen-cascades.test.ts`'s `wholeRowPersistUpdateApp`
    // fixture: a hand-authored trait passed straight to `OrbitalServerRuntime`
    // without ever running through `orbital-compiler`'s inline/resolve phase
    // or `@almadar/runtime`'s `resolveSentinelFields` twin, so it never gets
    // the `entity` marker at all — this caller's schema is real, resolved
    // registry `.orb` output, but this fixture stands in for that class.
    const unmarkedSchema: ReadonlyArray<PayloadField> = [
      { name: 'data', type: 'object', properties: [{ name: 'id', type: 'string' }] },
    ];
    const effects: ReadonlyArray<Effect> = [
      ['persist', 'update', 'Note', '@payload.data', { emit: { success: 'NOTE_UPDATED' } }],
    ];
    expect(findPersistWholeRowField(effects, unmarkedSchema)).toBe('data');
  });

  it('returns null when no persist effect is present', () => {
    const effects: ReadonlyArray<Effect> = [['emit', 'NOTE_UPDATED', {}]];
    expect(findPersistWholeRowField(effects, wholeRowSchema)).toBeNull();
  });
});

describe('findPersistWholeRowField / isWholeRowField convergence (C1-J3, item B)', () => {
  /**
   * `findPersistWholeRowField` (this file) and `plan-user-crud-flow.ts`'s
   * delete `payloadRowShape` used to be two independent detectors reading
   * `PayloadField.entity` differently — this proves they now AGREE on the
   * real `std-notes.orb` corpus shape: `NoteDelete.DELETE`'s `row` field,
   * resolved via `@almadar/runtime`'s `preprocessSchema` (the runtime
   * path — `orbital resolve`, the compiled path, stamps the same marker
   * on this field too, verified separately by hand while diagnosing item
   * B). Skips (not fails) when the registry file isn't on this checkout.
   */
  it("std-notes' NoteDelete.DELETE row field: both detectors agree it is Note's whole row", async () => {
    const registryPath = join(
      REPO_ROOT,
      'packages/almadar-behaviors/behaviors/registry/app/organisms/std-notes.orb',
    );
    if (!existsSync(registryPath)) return;

    const { preprocessSchema } = await import('@almadar/runtime');
    const schemaJson = JSON.parse(readFileSync(registryPath, 'utf-8')) as OrbitalSchema;
    const result = await preprocessSchema(schemaJson, {
      basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
      stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
      allowOutsideBasePath: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const noteDelete = result.data.schema.orbitals
      .flatMap((o) => o.traits)
      .map(asResolvedTrait)
      .find((t): t is Trait => t !== undefined && t.name === 'NoteDelete');
    expect(noteDelete).toBeDefined();
    if (noteDelete === undefined) return;

    const deleteSchema = noteDelete.stateMachine?.events?.find((e) => e.key === 'DELETE')?.payloadSchema;
    const rowField = deleteSchema?.find((f) => f.name === 'row');
    expect(rowField?.entity).toBe('Note');
    if (rowField === undefined) return;

    // `plan-user-crud-flow.ts`'s own detector, called directly.
    expect(isWholeRowField(rowField, 'Note')).toBe(true);

    // `findPersistWholeRowField`'s detector, on a representative
    // create/update persist effect writing this same field.
    const effects: ReadonlyArray<Effect> = [
      ['persist', 'update', 'Note', '@payload.row', { emit: { success: 'NOTE_UPDATED' } }],
    ];
    expect(findPersistWholeRowField(effects, deleteSchema)).toBe('row');
  });
});

describe('findPersistPayloadBinding (C1-V9 item B — the persistor shape)', () => {
  const wholeRowSchema: ReadonlyArray<PayloadField> = [
    { name: 'data', type: 'object', required: true, entity: 'Note' },
  ];

  it('shape 1 — whole-row: delegates to findPersistWholeRowField (`(persist update Note ?data)`, data : @entity!)', () => {
    const effects: ReadonlyArray<Effect> = [
      ['persist', 'update', 'Note', '@payload.data', { emit: { success: 'NOTE_UPDATED' } }],
    ];
    expect(findPersistPayloadBinding(effects, wholeRowSchema, 'Note')).toEqual({
      payloadField: 'data',
      wholeRow: true,
    });
  });

  it('shape 4 — `(set @entity.id ?id)` then `(persist update E @entity)` (std-version-history ROLLBACK, std-time-tracking SET_STATUS)', () => {
    const effects: ReadonlyArray<Effect> = [
      ['set', '@entity.id', '@payload.id'],
      ['set', '@entity.status', '@payload.status'],
      ['persist', 'update', 'TimeEntry', '@entity', { emit: { success: 'TimeEntryUpdated', failure: 'TimeEntryUpdateFailed' } }],
    ];
    expect(findPersistPayloadBinding(effects, [], 'TimeEntry')).toEqual({
      payloadField: 'id',
      wholeRow: false,
    });
    // The set must feed a persist of THIS entity's own row — a `set
    // @entity.id` beside a persist of another entity is not a self-binding.
    const otherEntity: ReadonlyArray<Effect> = [
      ['set', '@entity.id', '@payload.id'],
      ['persist', 'update', 'Other', '@payload.row'],
    ];
    expect(findPersistPayloadBinding(otherEntity, [], 'TimeEntry')).toBeNull();
  });

  it("shape 2 — scalar id on delete: `(persist delete Note ?id)`", () => {
    const effects: ReadonlyArray<Effect> = [
      ['persist', 'delete', 'Note', '@payload.id', { emit: { success: 'NOTE_DELETED' } }],
    ];
    expect(findPersistPayloadBinding(effects, [], 'Note')).toEqual({
      payloadField: 'id',
      wholeRow: false,
    });
  });

  it("shape 3 — literal object argument keyed by a top-level payload id: `(persist update Note { id: ?id, content: ?content })`", () => {
    const effects: ReadonlyArray<Effect> = [
      [
        'persist',
        'update',
        'Note',
        { id: '@payload.id', content: '@payload.content' },
        { emit: { success: 'NOTE_CONTENT_SAVED' } },
      ],
    ];
    expect(findPersistPayloadBinding(effects, [], 'Note')).toEqual({
      payloadField: 'id',
      wholeRow: false,
    });
  });

  it('a NESTED id path in the literal object (`{ id: ?data.id, … }`) is left unmatched — no single payload slot to fill', () => {
    const effects: ReadonlyArray<Effect> = [
      [
        'persist',
        'update',
        'Note',
        { id: '@payload.data.id', isFavorite: true },
        { emit: { success: 'NOTE_UPDATED' } },
      ],
    ];
    expect(findPersistPayloadBinding(effects, [], 'Note')).toBeNull();
  });

  it('returns null for create — no target row to bind', () => {
    const effects: ReadonlyArray<Effect> = [
      ['persist', 'create', 'Note', '@payload.data', { emit: { success: 'NOTE_CREATED' } }],
    ];
    expect(findPersistPayloadBinding(effects, wholeRowSchema, 'Note')).toBeNull();
  });

  it('returns null when the persist targets a DIFFERENT entity', () => {
    const effects: ReadonlyArray<Effect> = [
      ['persist', 'delete', 'OtherEntity', '@payload.id', { emit: { success: 'X' } }],
    ];
    expect(findPersistPayloadBinding(effects, [], 'Note')).toBeNull();
  });

  it('returns null when neither shape matches (e.g. a fully literal id with no payload reference)', () => {
    const effects: ReadonlyArray<Effect> = [
      ['persist', 'delete', 'Note', 'literal-id', { emit: { success: 'NOTE_DELETED' } }],
    ];
    expect(findPersistPayloadBinding(effects, [], 'Note')).toBeNull();
  });
});
