import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { planUserCrudFlow } from '../plan-user-crud-flow.js';

/**
 * Mirrors std-list's resolved (post-inline) shape: a Browse trait, a
 * Modal trait (CREATE/SAVE), an Edit Modal trait (EDIT/SAVE), a
 * Confirmation trait (DELETE/CONFIRM_DELETE), and a Persistor trait
 * with three persist transitions whose `emit.success` declares
 * ITEM_CREATED/UPDATED/DELETED. Each persist is triggered by the
 * Persistor's `listens` block from the matching modal/confirm trait.
 */
const stdListShape: OrbitalSchema = {
  name: 'std-list',
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
          { name: 'description', type: 'string' },
          { name: 'status', type: 'string', values: ['active', 'inactive', 'pending'] },
        ],
      },
      pages: [],
      traits: [
        {
          name: 'ListItemCreate',
          scope: 'instance',
          linkedEntity: 'ListItem',
          stateMachine: {
            states: [{ name: 'closed', isInitial: true }, { name: 'open' }],
            events: [
              { key: 'INIT', name: 'Init' },
              { key: 'CREATE', name: 'Create' },
              { key: 'LIST_ITEM_CREATED', name: 'Save', payloadSchema: [{ name: 'data', type: 'object', required: true }] },
            ],
            transitions: [
              {
                from: 'closed',
                to: 'open',
                event: 'CREATE',
                effects: [
                  ['render-ui', 'main', {
                    type: 'modal',
                    children: [
                      {
                        type: 'form-section',
                        fields: ['name', 'description', 'status'],
                        submitEvent: 'LIST_ITEM_CREATED',
                      },
                    ],
                  }],
                ],
              },
              { from: 'open', to: 'closed', event: 'LIST_ITEM_CREATED' },
            ],
          },
        },
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
                  ['render-ui', 'main', {
                    type: 'modal',
                    children: [
                      {
                        type: 'form-section',
                        fields: ['name', 'description', 'status'],
                        submitEvent: 'LIST_ITEM_UPDATED',
                      },
                    ],
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
              { from: 'idle', to: 'confirming', event: 'DELETE' },
              { from: 'confirming', to: 'idle', event: 'CONFIRM_DELETE' },
            ],
          },
        },
        {
          name: 'ListItemPersistor',
          scope: 'instance',
          linkedEntity: 'ListItem',
          listens: [
            { event: 'LIST_ITEM_CREATED', triggers: 'DO_CREATE', source: { kind: 'trait', trait: 'ListItemCreate' } },
            { event: 'LIST_ITEM_UPDATED', triggers: 'DO_UPDATE', source: { kind: 'trait', trait: 'ListItemEdit' } },
            { event: 'CONFIRM_DELETE', triggers: 'DO_DELETE', source: { kind: 'trait', trait: 'ListItemDelete' } },
          ],
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [
              { key: 'INIT', name: 'Init' },
              { key: 'DO_CREATE', name: 'Do Create' },
              { key: 'DO_UPDATE', name: 'Do Update' },
              { key: 'DO_DELETE', name: 'Do Delete' },
            ],
            transitions: [
              {
                from: 'idle',
                to: 'idle',
                event: 'DO_CREATE',
                effects: [['persist', 'create', 'ListItem', { data: '@payload.data', emit: { success: 'ITEM_CREATED' } }]],
              },
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

describe('planUserCrudFlow', () => {
  it('emits one create + one edit + one delete step per persistor entity', () => {
    const steps = planUserCrudFlow(stdListShape);
    expect(steps).toHaveLength(3);

    const create = steps.find((s) => s.testKind === 'crud-create');
    const edit = steps.find((s) => s.testKind === 'crud-edit');
    const del = steps.find((s) => s.testKind === 'crud-delete');

    expect(create).toBeDefined();
    expect(edit).toBeDefined();
    expect(del).toBeDefined();
  });

  it('crud-create step targets the modal trait OPEN affordance with submit chain', () => {
    const steps = planUserCrudFlow(stdListShape);
    const create = steps.find((s) => s.testKind === 'crud-create');
    expect(create?.traitName).toBe('ListItemCreate');
    expect(create?.event).toBe('CREATE');
    expect(create?.submitEvent).toBe('LIST_ITEM_CREATED');
    expect(create?.expectedSuccessEvent).toBe('ITEM_CREATED');
    expect(create?.expectedRowDelta).toEqual({ entityName: 'ListItem', delta: 1 });
    expect(create?.triggerKind).toBe('dom');
    expect(create?.formData).toBeDefined();
    expect(create?.expectedRowContent).toBeDefined();
  });

  it('crud-edit step carries expectedRowChangedFields matching its form data', () => {
    const steps = planUserCrudFlow(stdListShape);
    const edit = steps.find((s) => s.testKind === 'crud-edit');
    expect(edit?.event).toBe('EDIT');
    expect(edit?.submitEvent).toBe('LIST_ITEM_UPDATED');
    expect(edit?.expectedSuccessEvent).toBe('ITEM_UPDATED');
    expect(edit?.expectedRowDelta).toEqual({ entityName: 'ListItem', delta: 0 });
    expect(edit?.expectedRowChangedFields).toBeDefined();
    expect(edit?.expectedRowChangedFields?.length).toBeGreaterThan(0);
  });

  it('crud-delete step uses confirmEvent (not submitEvent) and no form data', () => {
    const steps = planUserCrudFlow(stdListShape);
    const del = steps.find((s) => s.testKind === 'crud-delete');
    expect(del?.event).toBe('DELETE');
    expect(del?.confirmEvent).toBe('CONFIRM_DELETE');
    expect(del?.submitEvent).toBeUndefined();
    expect(del?.formData).toBeUndefined();
    expect(del?.expectedSuccessEvent).toBe('ITEM_DELETED');
    expect(del?.expectedRowDelta).toEqual({ entityName: 'ListItem', delta: -1 });
    // No payloadSchema on DELETE in this fixture → no row shape.
    expect(del?.payloadRowShape).toBeUndefined();
  });

  it('crud-delete: payloadRowShape derives from the open event payloadSchema (entity-typed fields take the whole row)', () => {
    // std-delete's real shape: DELETE declares `id` + `row: <Entity>`,
    // guard `"@payload.row"`. The trigger needs the whole row for
    // `row` and `row.id` for `id` when it self-dispatches. `row`'s lowered
    // shape is `type: "object"` + the stamped `entity` marker (B1-V item
    // C) — `wholeRow` reads THAT, not `type`.
    const withDeleteSchema: OrbitalSchema = {
      ...stdListShape,
      orbitals: [
        {
          ...stdListShape.orbitals[0],
          traits: (stdListShape.orbitals[0].traits ?? []).map((t) => {
            if (typeof t === 'string' || 'ref' in t || t.name !== 'ListItemDelete') return t;
            return {
              ...t,
              stateMachine: {
                ...t.stateMachine!,
                events: (t.stateMachine?.events ?? []).map((e) =>
                  e.key === 'DELETE'
                    ? {
                        ...e,
                        payloadSchema: [
                          { name: 'id', type: 'string', required: true },
                          { name: 'row', type: 'object', entity: 'ListItem' },
                        ],
                      }
                    : e,
                ),
              },
            };
          }),
        },
      ],
    };
    const del = planUserCrudFlow(withDeleteSchema).find((s) => s.testKind === 'crud-delete');
    expect(del?.payloadRowShape).toEqual([
      { name: 'id', wholeRow: false },
      { name: 'row', wholeRow: true },
    ]);
  });

  it('crud-delete: a pre-marker payload (bare `type: entityName`, no `entity`) is deterministically NOT wholeRow', () => {
    // A registry `.orb` emitted BEFORE the `entity` marker existed (B1-V
    // item C) carries `row`'s type as the bare entity name with no
    // `entity` field — the honest absence of data, not a name-matching
    // fallback. `wholeRow` must read `false` for it.
    const withDeleteSchema: OrbitalSchema = {
      ...stdListShape,
      orbitals: [
        {
          ...stdListShape.orbitals[0],
          traits: (stdListShape.orbitals[0].traits ?? []).map((t) => {
            if (typeof t === 'string' || 'ref' in t || t.name !== 'ListItemDelete') return t;
            return {
              ...t,
              stateMachine: {
                ...t.stateMachine!,
                events: (t.stateMachine?.events ?? []).map((e) =>
                  e.key === 'DELETE'
                    ? { ...e, payloadSchema: [{ name: 'id', type: 'string', required: true }, { name: 'row', type: 'ListItem' }] }
                    : e,
                ),
              },
            };
          }),
        },
      ],
    };
    const del = planUserCrudFlow(withDeleteSchema).find((s) => s.testKind === 'crud-delete');
    expect(del?.payloadRowShape).toEqual([
      { name: 'id', wholeRow: false },
      { name: 'row', wholeRow: false },
    ]);
  });

  it('C1-V11: crud-delete attaches avoidReferencedVia when the entity self-relates; crud-edit does not', () => {
    // ListItem gains a self-relation field (mirrors std-notes' Note.parentId) —
    // a `persist delete` targeting the structurally-first row would hit the
    // mock seeder's tree-shape restrict-rejection every time. crud-edit is
    // unaffected by a restrict-rule self-relation (only deletes are), so it
    // must carry NO avoid-list even though the entity self-relates.
    const schema: OrbitalSchema = JSON.parse(JSON.stringify(stdListShape)) as OrbitalSchema;
    const entity = schema.orbitals[0].entity;
    if (typeof entity !== 'string' && 'fields' in entity) {
      entity.fields = [
        ...(entity.fields ?? []),
        { name: 'parentId', type: 'relation', relation: { entity: 'ListItem', cardinality: 'one' } },
      ];
    }

    const steps = planUserCrudFlow(schema);
    const edit = steps.find((s) => s.testKind === 'crud-edit');
    const del = steps.find((s) => s.testKind === 'crud-delete');

    expect(del?.avoidReferencedVia).toEqual(['parentId']);
    expect(edit?.avoidReferencedVia).toBeUndefined();
  });

  it('I-23: requiresRowContext stamps only steps whose open event declares required payload', () => {
    // Base fixture: DELETE/EDIT open events declare no payloadSchema → no flag.
    const bare = planUserCrudFlow(stdListShape);
    expect(bare.find((s) => s.testKind === 'crud-delete')?.requiresRowContext).toBeUndefined();
    expect(bare.find((s) => s.testKind === 'crud-edit')?.requiresRowContext).toBeUndefined();
    expect(bare.find((s) => s.testKind === 'crud-create')?.requiresRowContext).toBeUndefined();

    // std-delete's real shape: DELETE declares a REQUIRED `id` → a bare `{}`
    // fallback is a guaranteed rejection, so the step must carry the flag.
    const withDeleteSchema: OrbitalSchema = {
      ...stdListShape,
      orbitals: [
        {
          ...stdListShape.orbitals[0],
          traits: (stdListShape.orbitals[0].traits ?? []).map((t) => {
            if (typeof t === 'string' || 'ref' in t || t.name !== 'ListItemDelete') return t;
            return {
              ...t,
              stateMachine: {
                ...t.stateMachine!,
                events: (t.stateMachine?.events ?? []).map((e) =>
                  e.key === 'DELETE'
                    ? { ...e, payloadSchema: [{ name: 'id', type: 'string', required: true }] }
                    : e,
                ),
              },
            };
          }),
        },
      ],
    };
    const del = planUserCrudFlow(withDeleteSchema).find((s) => s.testKind === 'crud-delete');
    expect(del?.requiresRowContext).toBe(true);
  });

  it('produces no steps when the orbital has no persistor', () => {
    const noPersistor: OrbitalSchema = {
      ...stdListShape,
      orbitals: [
        {
          ...stdListShape.orbitals[0],
          traits: (stdListShape.orbitals[0].traits ?? []).filter(
            (t) => typeof t === 'string' || ('name' in t && t.name !== 'ListItemPersistor'),
          ),
        },
      ],
    };
    expect(planUserCrudFlow(noPersistor)).toEqual([]);
  });

  it('coverage keys carry the testKind suffix', () => {
    const steps = planUserCrudFlow(stdListShape);
    for (const step of steps) {
      expect(step.coverageKey).toMatch(/\[crud-(create|edit|delete)\]$/);
    }
  });

  // V-5: when the source trait reaches its open state via a cross-trait
  // listen-fanout (e.g. Delete.idle -DELETE-> confirming fired by
  // Browse rebroadcasting REQUEST_DELETE), the DOM affordance is the
  // upstream button (`action-REQUEST_DELETE`), not `action-<openEvent>`.
  // The planner must set `openAffordanceEvent` so the driver targets
  // the right button while the coverage key keeps the receiver event.
  it('crud-delete: when source trait has inbound listener {event ≠ triggers}, openAffordanceEvent overrides', () => {
    const withInboundListen: OrbitalSchema = {
      ...stdListShape,
      orbitals: [
        {
          ...stdListShape.orbitals[0],
          traits: (stdListShape.orbitals[0].traits ?? []).map((t) => {
            if (typeof t === 'string' || 'ref' in t || t.name !== 'ListItemDelete') return t;
            return {
              ...t,
              listens: [
                { event: 'REQUEST_DELETE', triggers: 'DELETE', source: { kind: 'trait', trait: 'ListItemBrowse' } },
              ],
            };
          }),
        },
      ],
    };
    const steps = planUserCrudFlow(withInboundListen);
    const del = steps.find((s) => s.testKind === 'crud-delete');
    expect(del).toBeDefined();
    // step.event stays as the receiver's transition event for coverage labelling.
    expect(del?.event).toBe('DELETE');
    expect(del?.coverageKey).toBe('ListItemDelete:idle+DELETE->confirming[crud-delete]');
    // openAffordanceEvent is the upstream button event the driver clicks.
    expect(del?.openAffordanceEvent).toBe('REQUEST_DELETE');
  });

  it('crud-delete: no openAffordanceEvent override when source trait has no inbound listener', () => {
    // The baseline fixture has no Delete.listens — affordance stays
    // implicit (driver uses step.event).
    const steps = planUserCrudFlow(stdListShape);
    const del = steps.find((s) => s.testKind === 'crud-delete');
    expect(del?.openAffordanceEvent).toBeUndefined();
  });

  it('crud-create: openAffordanceEvent is omitted when listener.event === listener.triggers', () => {
    // For std-list Create, even if Create had a Browse.CREATE→CREATE
    // listener, the names match — no override needed.
    const withMatchingListen: OrbitalSchema = {
      ...stdListShape,
      orbitals: [
        {
          ...stdListShape.orbitals[0],
          traits: (stdListShape.orbitals[0].traits ?? []).map((t) => {
            if (typeof t === 'string' || !('name' in t) || t.name !== 'ListItemCreate') return t;
            return {
              ...t,
              listens: [
                { event: 'CREATE', triggers: 'CREATE', source: { kind: 'trait', trait: 'ListItemBrowse' } },
              ],
            };
          }),
        },
      ],
    };
    const steps = planUserCrudFlow(withMatchingListen);
    const create = steps.find((s) => s.testKind === 'crud-create');
    expect(create?.event).toBe('CREATE');
    expect(create?.openAffordanceEvent).toBeUndefined();
  });
});

/**
 * C1-V9 item C: `isRowAction` classification — a row action is one
 * DECLARED in an `itemActions`/`browseItemActions`-shaped config array
 * (rendered once per row); a plain single button elsewhere on the page,
 * reached via the SAME cross-trait listener shape (a source/triggers
 * pair), is not. Mirrors the real `std-helpdesk` shapes: `TicketBrowse`
 * genuinely declares `itemActions` for its row EDIT control, while
 * `TicketDetail`'s "Rate your experience" button is a single `action:`
 * prop, never an itemActions array — the exact `TicketCsatSurvey`/RATE
 * shape that used to misreport as a missing row affordance.
 */
describe('planUserCrudFlow — isRowAction classification (C1-V9 item C)', () => {
  function rowActionSchema(): OrbitalSchema {
    return {
      name: 'row-action-fixture',
      designTokens: {},
      customPatterns: {},
      orbitals: [
        {
          name: 'TicketOrbital',
          entity: { name: 'Ticket', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] },
          pages: [],
          traits: [
            {
              // Genuine row action: EDIT declared in an itemActions-shaped
              // config array, rendered once per row by this browse trait.
              name: 'TicketBrowse',
              scope: 'collection',
              linkedEntity: 'Ticket',
              config: {
                itemActions: { type: 'array', default: [{ event: 'EDIT', label: 'Edit' }] },
              },
              stateMachine: {
                states: [{ name: 'browsing', isInitial: true }],
                events: [{ key: 'INIT', name: 'Init' }],
                transitions: [{ from: 'browsing', to: 'browsing', event: 'INIT' }],
              },
            },
            {
              // A plain single button, never declared in any itemActions
              // array — the "detail page" shape.
              name: 'TicketDetail',
              scope: 'instance',
              linkedEntity: 'Ticket',
              stateMachine: {
                states: [{ name: 'viewing', isInitial: true }],
                events: [{ key: 'INIT', name: 'Init' }],
                transitions: [{ from: 'viewing', to: 'viewing', event: 'INIT' }],
              },
            },
            {
              name: 'TicketEditModal',
              scope: 'instance',
              linkedEntity: 'Ticket',
              listens: [
                { event: 'EDIT', triggers: 'EDIT', source: { kind: 'trait', trait: 'TicketBrowse' } },
              ],
              stateMachine: {
                states: [{ name: 'closed', isInitial: true }, { name: 'open' }],
                events: [
                  { key: 'INIT', name: 'Init' },
                  { key: 'EDIT', name: 'Edit' },
                  { key: 'SAVE', name: 'Save', payloadSchema: [{ name: 'data', type: 'object', required: true }] },
                ],
                transitions: [
                  { from: 'closed', to: 'open', event: 'EDIT' },
                  { from: 'open', to: 'closed', event: 'SAVE' },
                ],
              },
            },
            {
              name: 'TicketCsatSurvey',
              scope: 'instance',
              linkedEntity: 'Ticket',
              listens: [
                { event: 'RATE', triggers: 'RATE', source: { kind: 'trait', trait: 'TicketDetail' } },
              ],
              stateMachine: {
                states: [{ name: 'closed', isInitial: true }, { name: 'open' }],
                events: [
                  { key: 'INIT', name: 'Init' },
                  { key: 'RATE', name: 'Rate' },
                  { key: 'SAVE', name: 'Save', payloadSchema: [{ name: 'data', type: 'object', required: true }] },
                ],
                transitions: [
                  { from: 'closed', to: 'open', event: 'RATE' },
                  { from: 'open', to: 'closed', event: 'SAVE' },
                ],
              },
            },
            {
              // Two SEPARATE persistor traits, matching std-helpdesk's real
              // shape exactly (TicketPersistor / TicketCsatPersistor) — one
              // `update` persist per (entity, kind) per persistor, since
              // `planUserCrudFlow`'s per-entity bucket keys by kind alone
              // and a second `update` on the SAME persistor would collide.
              name: 'TicketPersistor',
              scope: 'instance',
              linkedEntity: 'Ticket',
              listens: [
                { event: 'SAVE', triggers: 'DO_UPDATE', source: { kind: 'trait', trait: 'TicketEditModal' } },
              ],
              stateMachine: {
                states: [{ name: 'idle', isInitial: true }],
                events: [
                  { key: 'INIT', name: 'Init' },
                  { key: 'DO_UPDATE', name: 'Do update' },
                ],
                transitions: [
                  {
                    from: 'idle',
                    to: 'idle',
                    event: 'DO_UPDATE',
                    effects: [['persist', 'update', 'Ticket', { data: '@payload.data' }, { emit: { success: 'TICKET_UPDATED' } }]],
                  },
                ],
              },
            },
            {
              name: 'TicketCsatPersistor',
              scope: 'instance',
              linkedEntity: 'Ticket',
              listens: [
                { event: 'SAVE', triggers: 'DO_RATE', source: { kind: 'trait', trait: 'TicketCsatSurvey' } },
              ],
              stateMachine: {
                states: [{ name: 'idle', isInitial: true }],
                events: [
                  { key: 'INIT', name: 'Init' },
                  { key: 'DO_RATE', name: 'Do rate' },
                ],
                transitions: [
                  {
                    from: 'idle',
                    to: 'idle',
                    event: 'DO_RATE',
                    effects: [['persist', 'update', 'Ticket', { data: '@payload.data' }, { emit: { success: 'TICKET_RATED' } }]],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  it('a genuine row action (declared in itemActions) is classified isRowAction: true', () => {
    const steps = planUserCrudFlow(rowActionSchema());
    const edit = steps.find((s) => s.testKind === 'crud-edit' && s.traitName === 'TicketEditModal');
    expect(edit).toBeDefined();
    // listener.event === listener.triggers ('EDIT' both) — no override needed.
    expect(edit?.openAffordanceEvent).toBeUndefined();
    expect(edit?.isRowAction).toBe(true);
  });

  it("a plain single button reached the SAME cross-trait-listener way (never declared in itemActions) is classified isRowAction: false — the RATE/TicketCsatSurvey shape", () => {
    const steps = planUserCrudFlow(rowActionSchema());
    const rate = steps.find((s) => s.testKind === 'crud-edit' && s.traitName === 'TicketCsatSurvey');
    expect(rate).toBeDefined();
    expect(rate?.openAffordanceEvent).toBeUndefined();
    expect(rate?.isRowAction).toBe(false);
  });
});

describe('planUserCrudFlow — viewer requirement (C1-V10 item 1)', () => {
  /** `stdListShape` with an ownership access policy on `ListItem` —
   *  the std-notes shape (`Note.@create/@update/@delete = authorId ==
   *  @user.id`) grafted onto the crud-flow fixture, so create/edit/delete
   *  are all policed the same way. */
  function ownershipPolicedShape(): OrbitalSchema {
    const ownerPolicy = ['=', ['object/get', '@entity', 'authorId'], '@user.id'];
    return {
      ...stdListShape,
      orbitals: [
        {
          ...stdListShape.orbitals[0],
          entity: {
            name: 'ListItem',
            persistence: 'persistent',
            fields: [
              { name: 'id', type: 'string', required: true },
              { name: 'name', type: 'string', required: true },
              { name: 'description', type: 'string' },
              { name: 'status', type: 'string', values: ['active', 'inactive', 'pending'] },
              { name: 'authorId', type: 'string', required: true },
            ],
            create_policy: ownerPolicy,
            update_policy: ownerPolicy,
            delete_policy: ownerPolicy,
          },
        },
      ],
    };
  }

  it('crud-create carries the create-side owner requirement (useDefaultId + payloadOwnerField)', () => {
    const steps = planUserCrudFlow(ownershipPolicedShape());
    const create = steps.find((s) => s.testKind === 'crud-create');
    expect(create?.viewerRequirement).toEqual({
      owner: { sourceEntity: 'ListItem', sourceField: 'id', useDefaultId: true, payloadOwnerField: 'authorId' },
    });
  });

  it('crud-edit carries the update-side owner requirement (reads the target row\'s own owner column)', () => {
    const steps = planUserCrudFlow(ownershipPolicedShape());
    const edit = steps.find((s) => s.testKind === 'crud-edit');
    expect(edit?.viewerRequirement).toEqual({ owner: { sourceEntity: 'ListItem', sourceField: 'authorId' } });
  });

  it('crud-delete carries the delete-side owner requirement', () => {
    const steps = planUserCrudFlow(ownershipPolicedShape());
    const del = steps.find((s) => s.testKind === 'crud-delete');
    expect(del?.viewerRequirement).toEqual({ owner: { sourceEntity: 'ListItem', sourceField: 'authorId' } });
  });

  it('no viewerRequirement on any crud step when the entity declares no access policy (regression)', () => {
    const steps = planUserCrudFlow(stdListShape);
    for (const step of steps) {
      expect(step.viewerRequirement).toBeUndefined();
    }
  });
});
