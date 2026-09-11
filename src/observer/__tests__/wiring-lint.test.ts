import { describe, it, expect } from 'vitest';
import type { AnyPatternConfig, Effect, Entity, Orbital, OrbitalSchema, PageRef, SExpr, Trait, TraitRef, Transition, UISlot } from '@almadar/core';
import { isEntityCall, isEntityReference } from '@almadar/core';
import { lintWiring } from '../wiring-lint.js';

/** Minimal resolved-schema builder around one orbital. */
function schemaWith(orbital: Orbital): OrbitalSchema {
  return { name: 'fixture', orbitals: [orbital] };
}

/** Resolved-schema builder for the handful of tests that need more than
 *  one orbital (a single-orbital `schemaWith` argument list would collapse
 *  cross-orbital `listens`/theme checks onto one namespace). */
function schemaOf(orbitals: Orbital[]): OrbitalSchema {
  return { name: 'fixture', orbitals };
}

/**
 * Trait fixture builder. Only `name` is required — `scope` defaults to
 * `'instance'` (no fixture in this file exercises collection scope).
 * Routing every trait literal through this (rather than a bare object
 * literal assigned to an unannotated `const`) keeps nested literal types
 * (`scope: 'internal'`, tuple-typed `effects`) narrowed instead of
 * widened to `string` / element arrays wider than the tuple union —
 * the actual reason the file needed a double type-cast at every call site.
 */
function trait(t: { name: string } & Omit<Partial<Trait>, 'name'>): Trait {
  return { scope: 'instance', ...t };
}

/**
 * Orbital fixture builder. Only `name`, `traits`, `pages` are required —
 * `entity` defaults to a bare string reference. None of the checks this
 * file exercises reads a string-form `entity` (every reader guards on
 * `typeof entity === 'object'` before touching entity fields), so the
 * placeholder is inert wherever it isn't overridden.
 */
function orbital(
  o: { name: string; traits: TraitRef[]; pages: PageRef[] } & Omit<Partial<Orbital>, 'name' | 'traits' | 'pages'>,
): Orbital {
  return { entity: 'FixtureEntity', ...o };
}

const MODAL_RENDER: Effect = [
  'render-ui',
  'modal',
  { type: 'stack', children: ['@trait.RemoveIcon', '@trait.RemoveAlert'] },
];

describe('lintWiring — client-unbound-state-machine', () => {
  const removeConfirm = trait({
    name: 'RemoveConfirm',
    stateMachine: {
      states: [], events: [],
      transitions: [
        { from: 'idle', event: 'REQUEST_REMOVE', to: 'confirming', effects: [MODAL_RENDER] },
        { from: 'confirming', event: 'CONFIRM_REMOVE', to: 'idle', effects: [] },
      ],
    },
    listens: [
      { event: 'REQUEST_REMOVE', triggers: 'REQUEST_REMOVE', source: { kind: 'trait', trait: 'Browse' } },
    ],
  });
  const browse = trait({
    name: 'Browse',
    stateMachine: { states: [], events: [], transitions: [{ from: 'browsing', event: 'INIT', to: 'browsing', effects: [] }] },
    emits: [{ event: 'REQUEST_REMOVE', scope: 'internal', payloadSchema: [{ name: 'id', type: 'string' }] }],
  });
  const removeIcon = trait({ name: 'RemoveIcon', stateMachine: { states: [], events: [], transitions: [] } });
  const removeAlert = trait({ name: 'RemoveAlert', stateMachine: { states: [], events: [], transitions: [] } });

  it('flags the std-ecommerce shape: modal container omitted from the page decl its children mount on', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'CartOrbital',
        traits: [removeConfirm, browse, removeIcon, removeAlert],
        pages: [
          {
            name: 'CartPage',
            path: '/cart',
            traits: [{ ref: 'Browse' }, { ref: 'RemoveIcon' }, { ref: 'RemoveAlert' }],
          },
        ],
      })),
    );
    expect(result.errors).toBe(1);
    const finding = result.findings[0];
    expect(finding?.check).toBe('client-unbound-state-machine');
    expect(finding?.trait).toBe('RemoveConfirm');
    expect(finding?.suggestion).toContain('/cart');
  });

  it('is clean once the container is page-mounted (the applied fix)', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'CartOrbital',
        traits: [removeConfirm, browse, removeIcon, removeAlert],
        pages: [
          {
            name: 'CartPage',
            path: '/cart',
            traits: [{ ref: 'Browse' }, { ref: 'RemoveConfirm' }, { ref: 'RemoveIcon' }, { ref: 'RemoveAlert' }],
          },
        ],
      })),
    );
    // `browse` here declares REQUEST_REMOVE only in its emits contract (no
    // modeled click affordance) — a separate, correct
    // listener-affordance-removed-by-config warning; this test's concern is
    // client-unbound-state-machine only.
    expect(result.findings.filter((f) => f.check === 'client-unbound-state-machine')).toEqual([]);
  });

  it('credits binding through the transitive @trait embed closure, config and state machine alike', () => {
    const composer = trait({
      name: 'Composer',
      scope: 'instance', stateMachine: { states: [], events: [], 
        transitions: [
          { from: 'idle', event: 'INIT', to: 'idle', effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.Middle'] }]] },
        ],
      },
    });
    const middle = trait({ name: 'Middle', scope: 'instance', stateMachine: { states: [], events: [],  transitions: [] }, config: { body: { type: 'string', default: '@trait.RemoveConfirm' } } });
    const result = lintWiring(
      schemaWith(orbital({
        name: 'CartOrbital',
        traits: [composer, middle, removeConfirm, browse],
        pages: [{ name: 'CartPage', path: '/cart', traits: [{ ref: 'Composer' }, { ref: 'Browse' }] }],
      })),
    );
    // `browse` declares REQUEST_REMOVE only in its emits contract — see the
    // note in the sibling test above. `removeConfirm`'s shared MODAL_RENDER
    // fixture genuinely renders a stack into `modal` with no CLOSE/CANCEL
    // handled in `confirming` — a real modal-shell-close-deaf finding once
    // it's bound, orthogonal to this test's binding-closure concern.
    expect(
      result.findings.filter(
        (f) => f.check !== 'listener-affordance-removed-by-config' && f.check !== 'modal-shell-close-deaf',
      ),
    ).toEqual([]);
  });

  it('skips orbitals with no pages (registry atoms lint at their own page)', () => {
    const result = lintWiring(schemaWith(orbital({ name: 'AtomOrbital', traits: [removeConfirm], pages: [] })));
    expect(result.findings).toEqual([]);
  });
});

describe('lintWiring — listens-source-never-emits', () => {
  it('flags the std-cicd shape: route names a source that never produces the event', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'BuildOrbital',
        traits: [
          {
            name: 'BuildCatalog',
            scope: 'instance', stateMachine: { states: [], events: [],  transitions: [{ from: 'idle', event: 'INIT', to: 'idle', effects: [] }] },
          },
          {
            name: 'BuildButtonCreate',
            scope: 'instance',
            stateMachine: {
              states: [], events: [],
              transitions: [{ from: 'idle', event: 'INIT', to: 'idle', effects: [['render-ui', 'main', { type: 'button', action: 'CREATE' }]] }],
            },
          },
          {
            name: 'BuildCreate',
            scope: 'instance', stateMachine: { states: [], events: [],  transitions: [{ from: 'closed', event: 'CREATE', to: 'open', effects: [] }] },
            listens: [{ event: 'CREATE', triggers: 'CREATE', source: { kind: 'trait', trait: 'BuildCatalog' } }],
          },
        ],
        pages: [
          {
            name: 'BuildsPage',
            path: '/builds',
            traits: [{ ref: 'BuildCatalog' }, { ref: 'BuildButtonCreate' }, { ref: 'BuildCreate' }],
          },
        ],
      })),
    );
    expect(result.errors).toBe(1);
    const finding = result.findings[0];
    expect(finding?.check).toBe('listens-source-never-emits');
    expect(finding?.suggestion).toContain('BuildButtonCreate.CREATE');
  });

  it('a declared REF-trait source (composed schema, unresolved body) is EXISTENT — no phantom missing-source finding (G-REPAIR-RESET-1 round 3)', () => {
    // Composed schemas keep call-site ref-traits ({name, ref}) unresolved:
    // the source exists, its producibility just is not statically decidable.
    const result = lintWiring(
      schemaWith(orbital({
        name: 'TaskListOrbital',
        traits: [
          { name: 'ListCreate', ref: 'Modal.traits.ModalRecordModal' },
          {
            name: 'ListPersistor',
            scope: 'instance', stateMachine: { states: [], events: [],  transitions: [{ from: 'ready', event: 'DO_CREATE', to: 'ready', effects: [] }] },
            listens: [{ event: 'SAVE', triggers: 'DO_CREATE', source: { kind: 'trait', trait: 'ListCreate' } }],
          },
        ],
        pages: [
          {
            name: 'ListPage',
            path: '/list',
            traits: [{ ref: 'ListCreate' }, { ref: 'ListPersistor' }],
          },
        ],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'listens-source-never-emits')).toEqual([]);
  });

  it('a source that exists NOWHERE (neither inline nor declared ref) still flags missing-source', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'TaskListOrbital',
        traits: [
          {
            name: 'ListPersistor',
            scope: 'instance', stateMachine: { states: [], events: [],  transitions: [{ from: 'ready', event: 'DO_CREATE', to: 'ready', effects: [] }] },
            listens: [{ event: 'SAVE', triggers: 'DO_CREATE', source: { kind: 'trait', trait: 'GhostTrait' } }],
          },
        ],
        pages: [{ name: 'ListPage', path: '/list', traits: [{ ref: 'ListPersistor' }] }],
      })),
    );
    const missing = result.findings.filter((f) => f.check === 'listens-source-never-emits');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.message).toContain('GhostTrait does not exist');
  });

  it('credits every production form: emits contract, effect emit option, explicit emit effect, action affordance, itemActions', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'MixOrbital',
        traits: [
          {
            name: 'Grid',
            scope: 'instance', stateMachine: { states: [], events: [], 
              transitions: [
                {
                  from: 'idle',
                  event: 'INIT',
                  to: 'idle',
                  effects: [
                    ['fetch', 'Row', { emit: { success: 'RowsLoaded' } }],
                    ['emit', 'PING', { at: '@entity.id' }],
                    ['render-ui', 'main', { type: 'stack', children: [{ type: 'button', action: 'OPEN' }] }],
                  ],
                },
              ],
            },
            emits: [{ event: 'SELECTED', scope: 'internal' }],
            config: { itemActions: { type: 'array', default: [{ event: 'EDIT', label: 'Edit' }] } },
          },
          {
            name: 'Sink',
            scope: 'instance', stateMachine: { states: [], events: [], 
              transitions: [
                { from: 'a', event: 'W', to: 'a', effects: [] },
                { from: 'a', event: 'X', to: 'a', effects: [] },
                { from: 'a', event: 'Y', to: 'a', effects: [] },
                { from: 'a', event: 'Z', to: 'a', effects: [] },
                { from: 'a', event: 'V', to: 'a', effects: [] },
              ],
            },
            listens: [
              { event: 'RowsLoaded', triggers: 'W', source: { kind: 'trait', trait: 'Grid' } },
              { event: 'PING', triggers: 'X', source: { kind: 'trait', trait: 'Grid' } },
              { event: 'OPEN', triggers: 'Y', source: { kind: 'trait', trait: 'Grid' } },
              { event: 'SELECTED', triggers: 'Z', source: { kind: 'trait', trait: 'Grid' } },
              { event: 'EDIT', triggers: 'V', source: { kind: 'trait', trait: 'Grid' } },
            ],
          },
        ],
        pages: [{ name: 'P', path: '/p', traits: [{ ref: 'Grid' }, { ref: 'Sink' }] }],
      })),
    );
    // SELECTED is credited by contract alone (no live effect) — this test's
    // concern; it separately earns a listener-affordance-removed-by-config
    // warning (a route legal per contract but backed by no live mechanism),
    // which is a different check.
    expect(result.findings.filter((f) => f.check === 'listens-source-never-emits')).toEqual([]);
  });

  it('credits BOTH branches of a conditional (if-wrapped) action list — role-conditional lists are live emitters', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'CondOrbital',
        traits: [
          {
            name: 'Grid',
            scope: 'instance', stateMachine: { states: [], events: [],  transitions: [{ from: 'idle', event: 'INIT', to: 'idle', effects: [] }] },
            config: {
              itemActions: {
                type: 'array',
                default: [
                  'if',
                  ['=', '@user.role', 'reader'],
                  [{ event: 'VIEW', label: 'Open' }],
                  [{ event: 'VIEW', label: 'Open' }, { event: 'EDIT', label: 'Edit' }],
                ],
              },
            },
          },
          {
            name: 'Sink',
            scope: 'instance', stateMachine: { states: [], events: [], 
              transitions: [
                { from: 'a', event: 'X', to: 'a', effects: [] },
                { from: 'a', event: 'Y', to: 'a', effects: [] },
              ],
            },
            listens: [
              { event: 'VIEW', triggers: 'X', source: { kind: 'trait', trait: 'Grid' } },
              { event: 'EDIT', triggers: 'Y', source: { kind: 'trait', trait: 'Grid' } },
            ],
          },
        ],
        pages: [{ name: 'P', path: '/p', traits: [{ ref: 'Grid' }, { ref: 'Sink' }] }],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'listens-source-never-emits')).toEqual([]);
  });

  it('flags a route whose source trait does not exist', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'GhostOrbital',
        traits: [
          {
            name: 'Sink',
            scope: 'instance', stateMachine: { states: [], events: [],  transitions: [{ from: 'a', event: 'X', to: 'a', effects: [] }] },
            listens: [{ event: 'X', triggers: 'X', source: { kind: 'trait', trait: 'Ghost' } }],
          },
        ],
        pages: [{ name: 'P', path: '/p', traits: [{ ref: 'Sink' }] }],
      })),
    );
    expect(result.errors).toBe(1);
    expect(result.findings[0]?.message).toContain('does not exist');
  });
});

describe('lintWiring — listener-affordance-removed-by-config', () => {
  it('flags a listen route whose source contract declares the event but a config override (itemActions narrowed to VIEW-only) silenced the only live producer', () => {
    const browse = trait({
      name: 'Browse',
      emits: [{ event: 'EDIT_ROW', scope: 'internal' }],
      stateMachine: { states: [], events: [], transitions: [{ from: 'browsing', event: 'INIT', to: 'browsing', effects: [] }] },
      config: { itemActions: { type: 'array', default: [{ event: 'VIEW', label: 'View' }] } },
    });
    const editModal = trait({
      name: 'EditModal',
      stateMachine: { states: [], events: [], transitions: [{ from: 'idle', event: 'OPEN_EDIT', to: 'open', effects: [] }] },
      listens: [{ event: 'EDIT_ROW', triggers: 'OPEN_EDIT', source: { kind: 'trait', trait: 'Browse' } }],
    });
    const result = lintWiring(
      schemaWith(orbital({
        name: 'O',
        traits: [browse, editModal],
        pages: [{ name: 'P', path: '/p', traits: [{ ref: 'Browse' }, { ref: 'EditModal' }] }],
      })),
    );
    const found = result.findings.filter((f) => f.check === 'listener-affordance-removed-by-config');
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe('warning');
    expect(found[0]?.trait).toBe('EditModal');
    expect(found[0]?.message).toContain('EDIT_ROW');
    // Not a double-report: the contract HAS the event, so
    // listens-source-never-emits (which fires when the contract lacks it)
    // must stay silent on this same route.
    expect(result.findings.filter((f) => f.check === 'listens-source-never-emits')).toEqual([]);
  });

  it('stays silent once itemActions restores the event as a live producer', () => {
    const browse = trait({
      name: 'Browse',
      emits: [{ event: 'EDIT_ROW', scope: 'internal' }],
      stateMachine: { states: [], events: [], transitions: [{ from: 'browsing', event: 'INIT', to: 'browsing', effects: [] }] },
      config: { itemActions: { type: 'array', default: [{ event: 'VIEW', label: 'View' }, { event: 'EDIT_ROW', label: 'Edit' }] } },
    });
    const editModal = trait({
      name: 'EditModal',
      stateMachine: { states: [], events: [], transitions: [{ from: 'idle', event: 'OPEN_EDIT', to: 'open', effects: [] }] },
      listens: [{ event: 'EDIT_ROW', triggers: 'OPEN_EDIT', source: { kind: 'trait', trait: 'Browse' } }],
    });
    const result = lintWiring(
      schemaWith(orbital({
        name: 'O',
        traits: [browse, editModal],
        pages: [{ name: 'P', path: '/p', traits: [{ ref: 'Browse' }, { ref: 'EditModal' }] }],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'listener-affordance-removed-by-config')).toEqual([]);
  });
});

describe('lintWiring — payload-starved-route', () => {
  const modal = trait({
    name: 'CourseEdit',
    scope: 'instance', stateMachine: { states: [], events: [],  transitions: [{ from: 'closed', event: 'EDIT_COURSE', to: 'open', effects: [] }] },
    emits: [
      {
        event: 'EDIT_COURSE',
        scope: 'internal',
        payloadSchema: [
          { name: 'id', type: 'string', required: true },
          { name: 'row', type: 'Course' },
        ],
      },
    ],
    listens: [{ event: 'EDIT_COURSE', triggers: 'EDIT_COURSE', source: { kind: 'trait', trait: 'HeaderButton' } }],
  });

  it('flags the std-lms shape: header button emits the event with no payload while the contract requires id', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'CourseOrbital',
        traits: [
          modal,
          {
            name: 'HeaderButton',
            scope: 'instance', stateMachine: { states: [], events: [],  transitions: [] },
            emits: [{ event: 'EDIT_COURSE', scope: 'internal' }],
          },
        ],
        pages: [{ name: 'P', path: '/courses', traits: [{ ref: 'CourseEdit' }, { ref: 'HeaderButton' }] }],
      })),
    );
    expect(result.errors).toBe(1);
    // `HeaderButton` declares EDIT_COURSE only in its emits contract (no
    // live effect/render/config producer) — a separate, correct
    // listener-affordance-removed-by-config warning alongside this error.
    const finding = result.findings.find((f) => f.check === 'payload-starved-route');
    expect(finding?.message).toContain('{id}');
  });

  it('is satisfied by the itemActions native {id, row} payload (the applied std-lms fix)', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'CourseOrbital',
        traits: [
          { ...modal, listens: [{ event: 'EDIT_COURSE', triggers: 'EDIT_COURSE', source: { kind: 'trait', trait: 'Gallery' } }] },
          {
            name: 'Gallery',
            scope: 'instance', stateMachine: { states: [], events: [],  transitions: [] },
            config: { itemActions: { type: 'array', default: [{ event: 'EDIT_COURSE', label: 'Edit' }] } },
          },
        ],
        pages: [{ name: 'P', path: '/courses', traits: [{ ref: 'CourseEdit' }, { ref: 'Gallery' }] }],
      })),
    );
    expect(result.findings).toEqual([]);
  });

  it('credits payloadMapping renames when deciding starvation', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'SearchOrbital',
        traits: [
          {
            name: 'Search',
            scope: 'instance', stateMachine: { states: [], events: [],  transitions: [{ from: 'idle', event: 'SEARCH', to: 'searching', effects: [] }] },
            emits: [
              { event: 'SEARCH', scope: 'internal', payloadSchema: [{ name: 'searchTerm', type: 'string', required: true }] },
            ],
            listens: [
              {
                event: 'TOP_SEARCH',
                triggers: 'SEARCH',
                source: { kind: 'trait', trait: 'Layout' },
                // Canonical shape (core `applyListenPayloadMapping`):
                // {targetField: "@payload.<sourceField>"}.
                payloadMapping: { searchTerm: '@payload.value' },
              },
            ],
          },
          {
            name: 'Layout',
            scope: 'instance', stateMachine: { states: [], events: [],  transitions: [] },
            emits: [{ event: 'TOP_SEARCH', scope: 'internal', payloadSchema: [{ name: 'value', type: 'string' }] }],
          },
        ],
        pages: [{ name: 'P', path: '/p', traits: [{ ref: 'Search' }, { ref: 'Layout' }] }],
      })),
    );
    // `Layout` declares TOP_SEARCH only in its emits contract — a separate,
    // correct listener-affordance-removed-by-config warning; this test's
    // concern is payload starvation only.
    expect(result.findings.filter((f) => f.check === 'payload-starved-route')).toEqual([]);
  });

  // `with { k: <expr> }` values are full s-expressions, not just renames. A
  // value supplies its target when every `@payload.<field>` it reads is itself
  // supplied by the emitter — the escalating-ladder shape, where each rung
  // projects the next rung's inputs out of a carried request object.
  const ladderSchema = (emitterPayload: { name: string; type: string }[]) =>
    schemaWith(orbital({
      name: 'LadderOrbital',
      traits: [
        {
          name: 'LookupRung',
          scope: 'instance', stateMachine: { states: [], events: [],  transitions: [{ from: 'idle', event: 'LOOKUP', to: 'checked', effects: [] }] },
          emits: [
            {
              event: 'LOOKUP',
              scope: 'internal',
              payloadSchema: [
                { name: 'candidate', type: 'string', required: true },
                { name: 'accepted', type: 'array', required: true },
              ],
            },
          ],
          listens: [
            {
              event: 'EXACT_UNMATCHED',
              triggers: 'LOOKUP',
              source: { kind: 'trait', trait: 'ExactRung' },
              payloadMapping: {
                candidate: '@payload.candidate',
                accepted: ['object/get', '@payload.request', 'accepted'],
              },
            },
          ],
        },
        {
          name: 'ExactRung',
          scope: 'instance', stateMachine: { states: [], events: [],  transitions: [] },
          emits: [{ event: 'EXACT_UNMATCHED', scope: 'internal', payloadSchema: emitterPayload }],
        },
      ],
      pages: [{ name: 'P', path: '/p', traits: [{ ref: 'LookupRung' }, { ref: 'ExactRung' }] }],
    }));

  it('credits an expression mapping whose @payload reads are all supplied', () => {
    const result = lintWiring(
      ladderSchema([
        { name: 'candidate', type: 'string' },
        { name: 'request', type: 'object' },
      ]),
    );
    // `ExactRung` declares EXACT_UNMATCHED only in its emits contract — a
    // separate, correct listener-affordance-removed-by-config warning; this
    // test's concern is payload starvation only.
    expect(result.findings.filter((f) => f.check === 'payload-starved-route')).toEqual([]);
  });

  it('still reports starvation when an expression reads an unsupplied field', () => {
    // `request` is not emitted, so `(object/get @payload.request "accepted")`
    // evaluates over a hole and `accepted` is never really supplied.
    const result = lintWiring(ladderSchema([{ name: 'candidate', type: 'string' }]));
    const starved = result.findings.filter((f) => f.check === 'payload-starved-route');
    expect(starved).toHaveLength(1);
    expect(starved[0].message).toContain('accepted');
  });
});

describe('lintWiring — unclaimed-main-writer', () => {
  const mainRender = (pattern: AnyPatternConfig): Effect => ['render-ui', 'main', pattern];
  const contentBody: AnyPatternConfig = { type: 'stack', children: [{ type: 'typography', content: 'rows' }] };

  const shell = trait({
    name: 'AppLayout',
    config: { contentTrait: { type: 'string', default: '@trait.Search' } },
    scope: 'instance', stateMachine: { states: [], events: [], 
      transitions: [
        { from: 'composing', event: 'INIT', to: 'composing', effects: [mainRender({ type: 'box', children: ['@trait.Search'] })] },
      ],
    },
  });
  const search = trait({
    name: 'Search',
    config: { idleContent: { type: 'string', default: '@trait.Catalog' } },
    scope: 'instance', stateMachine: { states: [], events: [], 
      transitions: [{ from: 'idle', event: 'INIT', to: 'idle', effects: [mainRender({ type: 'box', children: ['@trait.Catalog'] })] }],
    },
  });
  const catalog = trait({
    name: 'Catalog',
    scope: 'instance', stateMachine: { states: [], events: [], 
      transitions: [{ from: 'browsing', event: 'INIT', to: 'browsing', effects: [mainRender(contentBody)] }],
    },
  });
  const page = (extraRefs: string[]) => ({
    name: 'P',
    path: '/p',
    traits: [{ ref: 'AppLayout' }, { ref: 'Search' }, { ref: 'Catalog' }, ...extraRefs.map((ref) => ({ ref }))],
  });

  it('is clean on the composed convention (shell + channel-claimed content body)', () => {
    const result = lintWiring(
      schemaWith(orbital({ name: 'O', traits: [shell, search, catalog], pages: [page([])] })),
    );
    expect(result.findings).toEqual([]);
  });

  it('warns on an unclaimed second content body (the std-accounting /entries shape)', () => {
    const secondBrowse = trait({
      name: 'SecondBrowse',
      scope: 'instance', stateMachine: { states: [], events: [], 
        transitions: [{ from: 'browsing', event: 'INIT', to: 'browsing', effects: [mainRender({ type: 'data-grid', entity: 'Row' })] }],
      },
    });
    const result = lintWiring(
      schemaWith(orbital({ name: 'O', traits: [shell, search, catalog, secondBrowse], pages: [page(['SecondBrowse'])] })),
    );
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(1);
    expect(result.findings[0]?.check).toBe('unclaimed-main-writer');
    expect(result.findings[0]?.trait).toBe('SecondBrowse');
  });

  it('is clean once the second body is claimed through the channel (the applied fix)', () => {
    const claimedBrowse = trait({
      name: 'SecondBrowse',
      scope: 'instance', stateMachine: { states: [], events: [], 
        transitions: [{ from: 'browsing', event: 'INIT', to: 'browsing', effects: [mainRender({ type: 'data-grid', entity: 'Row' })] }],
      },
    });
    const fixedSearch: Trait = { ...search, config: { idleContent: { type: 'string', default: '@trait.SecondBrowse' } } };
    const result = lintWiring(
      schemaWith(orbital({
        name: 'O',
        traits: [shell, fixedSearch, claimedBrowse],
        pages: [{ name: 'P', path: '/p', traits: [{ ref: 'AppLayout' }, { ref: 'Search' }, { ref: 'SecondBrowse' }] }],
      })),
    );
    expect(result.findings).toEqual([]);
  });

  it('ignores modal-cleanup placeholder main-writes (childless box)', () => {
    const modal = trait({
      name: 'Edit',
      scope: 'instance', stateMachine: { states: [], events: [], 
        transitions: [
          { from: 'open', event: 'CLOSE', to: 'closed', effects: [mainRender({ type: 'box' }), ['render-ui', 'modal', null]] },
        ],
      },
    });
    const result = lintWiring(
      schemaWith(orbital({ name: 'O', traits: [shell, search, catalog, modal], pages: [page(['Edit'])] })),
    );
    expect(result.findings).toEqual([]);
  });

  it('ignores page-mounted atomic chrome', () => {
    const chrome = trait({
      name: 'InlineIconRender1',
      scope: 'instance', stateMachine: { states: [], events: [], 
        transitions: [{ from: 'idle', event: 'INIT', to: 'idle', effects: [mainRender({ type: 'icon' })] }],
      },
    });
    const result = lintWiring(
      schemaWith(orbital({ name: 'O', traits: [shell, search, catalog, chrome], pages: [page(['InlineIconRender1'])] })),
    );
    expect(result.findings).toEqual([]);
  });

  it('ignores a page-mounted feature when no channel body exists (shell+feature convention)', () => {
    const bareShell = trait({
      name: 'AppLayout',
      scope: 'instance', stateMachine: { states: [], events: [], 
        transitions: [{ from: 'composing', event: 'INIT', to: 'composing', effects: [mainRender({ type: 'box', children: [] })] }],
      },
    });
    const feature = trait({
      name: 'Upload',
      scope: 'instance', stateMachine: { states: [], events: [], 
        transitions: [{ from: 'idle', event: 'INIT', to: 'idle', effects: [mainRender(contentBody)] }],
      },
    });
    const result = lintWiring(
      schemaWith(orbital({
        name: 'O',
        traits: [bareShell, feature],
        pages: [{ name: 'P', path: '/p', traits: [{ ref: 'AppLayout' }, { ref: 'Upload' }] }],
      })),
    );
    expect(result.findings).toEqual([]);
  });

  // --- 2026-08-02 recalibration controls -----------------------------------
  // Proven root cause (std-winning-11, all 10 findings FP): the pre-fix check
  // computed its "channel" from `collectTraitConfigRefAdjacency` ORBITAL-WIDE
  // instead of per page, and never applied the CONTAINMENT reduction
  // `resolvePageContentOwner`/`reduceToOwners` (`@almadar/core`) already use
  // for `viewer-stranded` above. Both controls below pin the fix: a genuine
  // channel + an unrelated second writer must still fire (a real defect must
  // not go silent), and a composing trait that CONTAINS its own channel
  // (the materialised-JSX shape: `orbital resolve` promotes nested
  // `<Card>`/`<SimpleGrid>` into synthetic sibling traits chained by
  // `@trait.X` config forwards, e.g. std-browse's `DataGrid1` /
  // `DenseTableView` / `MasterListView`) must not be flagged as a rival to
  // its own descendant (std-winning-11's `AssessmentForm` over
  // `InlineFormSectionRender31`).

  it('POSITIVE CONTROL: a real authored channel plus a wholly unrelated second writer still reports', () => {
    // ShellWithChannel -> (contentTrait) -> ChannelBody: an authored,
    // single-link designation chain — a genuine, unambiguous channel owner.
    const shellWithChannel = trait({
      name: 'ShellWithChannel',
      config: { contentTrait: { type: 'string', default: '@trait.ChannelBody' } },
      scope: 'instance', stateMachine: { states: [], events: [], 
        transitions: [
          { from: 'composing', event: 'INIT', to: 'composing', effects: [mainRender({ type: 'box', children: ['@trait.ChannelBody'] })] },
        ],
      },
    });
    const channelBody = trait({
      name: 'ChannelBody',
      scope: 'instance', stateMachine: { states: [], events: [], 
        transitions: [{ from: 'browsing', event: 'INIT', to: 'browsing', effects: [mainRender(contentBody)] }],
      },
    });
    // StrayFeature shares no designation or containment edge with either of
    // the above — a genuinely independent second body stacked on the page.
    const strayFeature = trait({
      name: 'StrayFeature',
      scope: 'instance', stateMachine: { states: [], events: [], 
        transitions: [{ from: 'idle', event: 'INIT', to: 'idle', effects: [mainRender(contentBody)] }],
      },
    });
    const result = lintWiring(
      schemaWith(orbital({
        name: 'O',
        traits: [shellWithChannel, channelBody, strayFeature],
        pages: [
          {
            name: 'P',
            path: '/p',
            traits: [{ ref: 'ShellWithChannel' }, { ref: 'ChannelBody' }, { ref: 'StrayFeature' }],
          },
        ],
      })),
    );
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(1);
    expect(result.findings[0]?.check).toBe('unclaimed-main-writer');
    expect(result.findings[0]?.trait).toBe('StrayFeature');
  });

  it('NEGATIVE CONTROL: a composing trait that CONTAINS its own materialised channel is not a rival to it', () => {
    // OuterComposer embeds MiddleWrapper directly in its render-ui (state
    // machine only, no config forward) — the materialised-JSX shape: an
    // ordinary `@trait.X` embed, not a designation.
    const outerComposer = trait({
      name: 'OuterComposer',
      scope: 'instance', stateMachine: { states: [], events: [], 
        transitions: [
          { from: 'composing', event: 'INIT', to: 'composing', effects: [mainRender({ type: 'box', children: ['@trait.MiddleWrapper'] })] },
        ],
      },
    });
    // MiddleWrapper designates InnerBody through config — the synthetic
    // sibling's own internal channel link (std-browse's DataGrid1 ->
    // DenseTableView -> MasterListView chain, flattened here to one hop).
    const middleWrapper = trait({ name: 'MiddleWrapper', config: { body: { type: 'string', default: '@trait.InnerBody' } } });
    const innerBody = trait({
      name: 'InnerBody',
      scope: 'instance', stateMachine: { states: [], events: [], 
        transitions: [{ from: 'browsing', event: 'INIT', to: 'browsing', effects: [mainRender(contentBody)] }],
      },
    });
    const result = lintWiring(
      schemaWith(orbital({
        name: 'O',
        traits: [outerComposer, middleWrapper, innerBody],
        pages: [
          {
            name: 'P',
            path: '/p',
            traits: [{ ref: 'OuterComposer' }, { ref: 'MiddleWrapper' }, { ref: 'InnerBody' }],
          },
        ],
      })),
    );
    expect(result.findings).toEqual([]);
  });
});

describe('lintWiring — steady-state-no-init-reentry', () => {
  const mainRender = (pattern: AnyPatternConfig): Effect => ['render-ui', 'main', pattern];
  const rowsBody: AnyPatternConfig = { type: 'stack', children: [{ type: 'data-grid' }] };
  const spinner: AnyPatternConfig = { type: 'loading-state', title: 'Loading…' };
  const fetchRows: Effect = ['fetch', 'Board', { emit: { success: 'RowsLoaded', failure: 'RowsFailed' } }];

  /** The std-board shape: `loading` fetches, `browsing` shows the rows. */
  const browseTrait = (browsingTransitions: Transition[]): Trait => trait({
    name: 'Board',
    stateMachine: {
      states: [{ name: 'loading', isInitial: true }, { name: 'browsing' }],
      events: [],
      transitions: [
        { from: 'loading', event: 'INIT', to: 'loading', effects: [fetchRows, mainRender(spinner)] },
        { from: 'loading', event: 'RowsLoaded', to: 'browsing', effects: [mainRender(rowsBody)] },
        ...browsingTransitions,
      ],
    },
  });

  const page = { name: 'P', path: '/board', traits: [{ ref: 'Board' }] };

  it('flags a loaded steady state that handles no INIT (the permanent-spinner family)', () => {
    const result = lintWiring(
      schemaWith(orbital({ name: 'O', traits: [browseTrait([{ from: 'browsing', event: 'OPEN_CARD', to: 'browsing', effects: [] }])], pages: [page] })),
    );
    const finding = result.findings.find((f) => f.check === 'steady-state-no-init-reentry');
    expect(finding).toBeDefined();
    expect(finding?.trait).toBe('Board');
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain("'browsing'");
    expect(finding?.suggestion).toContain('INIT re-entry');
  });

  it('is clean once the steady state mirrors the loading INIT (the applied fix)', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'O',
        traits: [browseTrait([{ from: 'browsing', event: 'INIT', to: 'loading', effects: [fetchRows, mainRender(spinner)] }])],
        pages: [page],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'steady-state-no-init-reentry')).toEqual([]);
  });

  it('accepts a wildcard INIT as covering every steady state', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'O',
        traits: [browseTrait([{ from: '*', event: 'INIT', to: 'loading', effects: [fetchRows] }])],
        pages: [page],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'steady-state-no-init-reentry')).toEqual([]);
  });

  it('ignores a steady state that paints no content body (nothing visible to strand)', () => {
    const logger = trait({
      name: 'Board',
      scope: 'instance', stateMachine: {
        events: [],
        states: [{ name: 'loading', isInitial: true }, { name: 'browsing' }],
        transitions: [
          { from: 'loading', event: 'INIT', to: 'loading', effects: [fetchRows] },
          { from: 'loading', event: 'RowsLoaded', to: 'browsing', effects: [['set', '@entity.rows', '?data']] },
        ],
      },
    });
    const result = lintWiring(schemaWith(orbital({ name: 'O', traits: [logger], pages: [page] })));
    expect(result.findings.filter((f) => f.check === 'steady-state-no-init-reentry')).toEqual([]);
  });

  it('ignores a trait the client never binds (no page decl, no embed)', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'O',
        traits: [browseTrait([]), { name: 'Shell', scope: 'instance', stateMachine: { states: [], events: [],  transitions: [{ from: 'idle', event: 'INIT', to: 'idle', effects: [] }] } }],
        pages: [{ name: 'P', path: '/board', traits: [{ ref: 'Shell' }] }],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'steady-state-no-init-reentry')).toEqual([]);
  });
});

describe('lintWiring — unscoped-owned-entity', () => {
  /**
   * An app whose `Ticket.assignee` points at the `[identity]` `Person`.
   * `readPolicy` is the `@read` directive; absent means ALLOW-ALL.
   */
  function appWithOwnerColumn(readPolicy?: SExpr): OrbitalSchema {
    return {
      name: 'fixture',
      orbitals: [
        {
          name: 'TicketOrbital',
          entity: {
            name: 'Ticket',
            persistence: 'persistent',
            collection: 'tickets',
            ...(readPolicy === undefined ? {} : { read_policy: readPolicy }),
            fields: [
              { name: 'id', type: 'string' },
              { name: 'assignee', type: 'relation', relation: { entity: 'Person' } },
            ],
          },
          traits: [],
          pages: [],
        },
        {
          name: 'PersonOrbital',
          entity: {
            name: 'Person',
            identity: true,
            persistence: 'persistent',
            collection: 'people',
            fields: [{ name: 'id', type: 'string' }],
          },
          traits: [],
          pages: [],
        },
      ],
    };
  }

  const unscoped = (schema: OrbitalSchema) =>
    lintWiring(schema).findings.filter((f) => f.check === 'unscoped-owned-entity');

  it('flags an owner column with no @read — undeclared is allow-all, not deny-all', () => {
    const found = unscoped(appWithOwnerColumn());
    expect(found).toHaveLength(1);
    expect(found[0]?.entity).toBe('Ticket');
    expect(found[0]?.severity).toBe('warning');
    expect(found[0]?.message).toContain('assignee');
  });

  it('is silent once @read is declared', () => {
    expect(unscoped(appWithOwnerColumn(['=', '@entity.assignee', '@user.id']))).toHaveLength(0);
  });

  it('is silent for an app that declares no [identity] entity at all', () => {
    // Owner columns are resolved from the DECLARED relation to the identity
    // entity. With no identity there is nothing to scope against, so an
    // un-migrated app stays quiet rather than emitting noise for every entity.
    const schema: OrbitalSchema = {
      name: 'fixture',
      orbitals: [
        {
          name: 'TicketOrbital',
          entity: {
            name: 'Ticket',
            persistence: 'persistent',
            collection: 'tickets',
            fields: [{ name: 'assignee', type: 'relation', relation: { entity: 'Person' } }],
          },
          traits: [],
          pages: [],
        },
      ],
    };
    expect(unscoped(schema)).toHaveLength(0);
  });

  it('does not guess from a field NAME — a bare string owner is invisible', () => {
    // Name matching would scope the wrong column. The campaign retypes these to
    // a real reference, and the lint lights up only then.
    const schema = appWithOwnerColumn();
    const ticket = schema.orbitals[0]?.entity;
    if (ticket === undefined || isEntityReference(ticket) || isEntityCall(ticket)) {
      throw new Error('fixture entity must be an inline Entity');
    }
    ticket.fields = [{ name: 'assignee', type: 'string' }];
    expect(unscoped(schema)).toHaveLength(0);
  });
});

describe('lintWiring — unscoped-owned-entity respects a declared waiver', () => {
  function appWithWaiver(waiver?: Record<string, string>): OrbitalSchema {
    return {
      name: 'fixture',
      orbitals: [
        {
          name: 'ReplyOrbital',
          entity: {
            name: 'TicketReply',
            persistence: 'persistent',
            collection: 'ticketreplies',
            ...(waiver === undefined ? {} : { access_waivers: waiver }),
            fields: [{ name: 'authorId', type: 'relation', relation: { entity: 'Person' } }],
          },
          traits: [],
          pages: [],
        },
        {
          name: 'PersonOrbital',
          entity: {
            name: 'Person',
            identity: true,
            persistence: 'persistent',
            collection: 'people',
            fields: [{ name: 'id', type: 'string' }],
          },
          traits: [],
          pages: [],
        },
      ],
    };
  }

  const unscoped = (schema: OrbitalSchema) =>
    lintWiring(schema).findings.filter((f) => f.check === 'unscoped-owned-entity');

  it('flags the omission when nothing declares it', () => {
    expect(unscoped(appWithWaiver())).toHaveLength(1);
  });

  it('goes quiet once `@read none "<reason>"` declares it', () => {
    // The point of the waiver: a lint that keeps flagging correct code is one
    // people learn to scroll past, which costs the signal on the real gaps.
    expect(unscoped(appWithWaiver({ read: 'visibility follows the Ticket' }))).toHaveLength(0);
  });

  it('a waiver on a DIFFERENT operation does not silence @read', () => {
    expect(unscoped(appWithWaiver({ delete: 'moderation only' }))).toHaveLength(1);
  });
});

describe('lintWiring — dead-bodiless-action', () => {
  const painted = (slot: UISlot): Effect => ['render-ui', slot, { type: 'stack', children: [] }];

  it('flags a state-changing arm with no effects, on a state this trait paints', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'PreviewOrbital',
        traits: [
          {
            name: 'SchemaPreview',
            scope: 'instance', stateMachine: { states: [], events: [], 
              transitions: [
                { from: 'loading', event: 'PREVIEW_ERROR', to: 'error', effects: [painted('main')] },
                { from: 'error', event: 'START_PREVIEW', to: 'loading', effects: [] },
              ],
            },
          },
        ],
        pages: [{ name: 'PreviewPage', path: '/preview', traits: [{ ref: 'SchemaPreview' }] }],
      })),
    );
    const found = result.findings.filter((f) => f.check === 'dead-bodiless-action');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('error -> loading');
  });

  it('does not flag a lifecycle trait that paints nothing, nor a bodiless self-transition', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'PreviewOrbital',
        traits: [
          {
            name: 'ProjectErasure',
            scope: 'instance', stateMachine: { states: [], events: [], 
              transitions: [
                { from: 'execScanning', event: 'ExecScanLoaded', to: 'idle', effects: [] },
                { from: 'idle', event: 'STOP', to: 'idle', effects: [] },
              ],
            },
          },
        ],
        pages: [{ name: 'P', path: '/p', traits: [{ ref: 'ProjectErasure' }] }],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'dead-bodiless-action')).toHaveLength(0);
  });
});

describe('lintWiring — dead-lifecycle-emit', () => {
  it('flags (emit INIT) used as a repaint', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'PreviewOrbital',
        traits: [
          {
            name: 'SchemaPreview',
            scope: 'instance', stateMachine: { states: [], events: [], 
              transitions: [
                {
                  from: 'previewing',
                  event: 'STOP_PREVIEW',
                  to: 'idle',
                  effects: [['set', '@entity.isRunning', false], ['emit', 'INIT']],
                },
              ],
            },
          },
        ],
        pages: [{ name: 'P', path: '/p', traits: [{ ref: 'SchemaPreview' }] }],
      })),
    );
    const found = result.findings.filter((f) => f.check === 'dead-lifecycle-emit');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("emits 'INIT'");
  });

  it('leaves a normal (emit X) alone', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'PreviewOrbital',
        traits: [
          {
            name: 'SchemaPreview',
            scope: 'instance', stateMachine: { states: [], events: [], 
              transitions: [
                { from: 'previewing', event: 'STOP_PREVIEW', to: 'idle', effects: [['emit', 'PREVIEW_STOPPED']] },
              ],
            },
          },
        ],
        pages: [{ name: 'P', path: '/p', traits: [{ ref: 'SchemaPreview' }] }],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'dead-lifecycle-emit')).toHaveLength(0);
  });
});

describe('lintWiring — dead-lifecycle-action reads registry-declared event props', () => {
  const pageFor = (trait: string): PageRef => ({ name: 'P', path: '/p', traits: [{ ref: trait }] });
  const traitRendering = (name: string, node: AnyPatternConfig): Trait => trait({
    name,
    stateMachine: { states: [], events: [], transitions: [{ from: 'idle', event: 'INIT', to: 'idle', effects: [['render-ui', 'main', node]] }] },
  });
  const lifecycleFindings = (node: AnyPatternConfig) =>
    lintWiring(
      schemaWith(orbital({ name: 'O', traits: [traitRendering('T', node)], pages: [pageFor('T')] })),
    ).findings.filter((f) => f.check === 'dead-lifecycle-action');

  it('flags `action` — the shape the pre-widening rule already caught', () => {
    expect(lifecycleFindings({ type: 'button', action: 'INIT' })).toHaveLength(1);
  });

  it("flags error-state's `retryEvent`/`onRetry` (the std-cms upload-failure retry)", () => {
    expect(lifecycleFindings({ type: 'error-state', retryEvent: 'INIT', onRetry: 'INIT' })).toHaveLength(1);
  });

  it("flags form-section's `cancelEvent` (the std-form-advanced dead Cancel)", () => {
    expect(lifecycleFindings({ type: 'form-section', fields: [], cancelEvent: 'INIT' })).toHaveLength(1);
  });

  it("flags empty-state's `actionEvent` (the std-inventory 'Back to inventory')", () => {
    expect(lifecycleFindings({ type: 'empty-state', actionEvent: 'LOAD' })).toHaveLength(1);
  });

  it('resolves the prop against the node type — an undeclared prop of the same name is not an affordance', () => {
    // `retryEvent` isn't a declared `typography` prop — held in a variable
    // (not a fresh literal) so the excess property lands as a genuine extra
    // field on the value the lint scans, exactly what the assertion tests.
    const node = { type: 'typography' as const, retryEvent: 'INIT' };
    expect(lifecycleFindings(node)).toHaveLength(0);
  });

  it('leaves a first-class event on a declared prop alone', () => {
    expect(lifecycleFindings({ type: 'error-state', retryEvent: 'RETRY', onRetry: 'RETRY' })).toHaveLength(0);
  });

  it('reads an event-list descriptor array through its declared eventField', () => {
    expect(
      lifecycleFindings({ type: 'data-grid', entity: 'Row', itemActions: [{ event: 'INIT', label: 'Refresh' }] }),
    ).toHaveLength(1);
  });
});

describe('lintWiring — viewer-stranded credits value-input controls', () => {
  const mainRender = (pattern: AnyPatternConfig): Effect => ['render-ui', 'main', pattern];
  const page: PageRef = { name: 'P', path: '/lab', traits: [{ ref: 'Lab' }] };

  const labWith = (repaintBody: AnyPatternConfig): Trait => trait({
    name: 'Lab',
    stateMachine: {
      events: [],
      states: [{ name: 'idle', isInitial: true }],
      transitions: [
        {
          from: 'idle',
          event: 'INIT',
          to: 'idle',
          effects: [mainRender({ type: 'stack', children: [{ type: 'typography', content: 'rows' }, { type: 'range-slider', value: 10, onChange: 'SET_X' }] })],
        },
        { from: 'idle', event: 'SET_X', to: 'idle', effects: [['set', '@entity.x', '?value'], mainRender(repaintBody)] },
      ],
    },
  });

  it('a labelless range-slider with a wired onChange is a way on (the learning-lab shape)', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'O',
        traits: [labWith({ type: 'stack', children: [{ type: 'range-slider', value: 10, onChange: 'SET_X' }] })],
        pages: [page],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'viewer-stranded')).toEqual([]);
  });

  it('POSITIVE CONTROL: a labelless button-only repaint still strands', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'O',
        traits: [labWith({ type: 'stack', children: [{ type: 'button', action: 'SET_X' }] })],
        pages: [page],
      })),
    );
    const stranded = result.findings.filter((f) => f.check === 'viewer-stranded');
    expect(stranded).toHaveLength(1);
    expect(stranded[0].trait).toBe('Lab');
  });

  it('an S-expression label the render evaluator resolves to text is a way on (the earth-lab shape)', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'O',
        traits: [
          labWith({
            type: 'stack',
            children: [
              ['array/map', '@config.boundaries', ['fn', 'bnd', { type: 'button', action: 'SET_X', label: ['object/get', '@bnd', 'label'] }]],
              { type: 'button', action: 'SET_X', label: ['str/concat', 'Advance ', '@config.stepYears', ' Million Years'] },
            ],
          }),
        ],
        pages: [page],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'viewer-stranded')).toEqual([]);
  });

  it('POSITIVE CONTROL: an unresolved string-sigil label still strands', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'O',
        traits: [labWith({ type: 'stack', children: [{ type: 'button', action: 'SET_X', label: '@config.actionLabel' }] })],
        pages: [page],
      })),
    );
    const stranded = result.findings.filter((f) => f.check === 'viewer-stranded');
    expect(stranded).toHaveLength(1);
    expect(stranded[0].trait).toBe('Lab');
  });

  // SCAN-LINT-UNRESOLVED-REF-1: a composed schema stores call-site traits as
  // unresolved refs. An embed of a DECLARED ref trait is content-unknown,
  // never content-empty — the check may not assert "no data surface" over it
  // (std-notes NoteDocPage false-positived on `@trait.NoteDoc` →
  // `ref: RecordDetail.traits.RecordItemDetail`).
  it('an embed of a declared ref trait is a way on, not a strand (the composed std-notes shape)', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'O',
        traits: [
          labWith({ type: 'stack', children: ['@trait.DocSurface'] }),
          { name: 'DocSurface', ref: 'RecordDetail.traits.RecordItemDetail', config: {} },
        ],
        pages: [page],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'viewer-stranded')).toEqual([]);
  });

  it('POSITIVE CONTROL: an embed naming an UNDECLARED trait still strands', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'O',
        traits: [labWith({ type: 'stack', children: ['@trait.Ghost'] })],
        pages: [page],
      })),
    );
    const stranded = result.findings.filter((f) => f.check === 'viewer-stranded');
    expect(stranded).toHaveLength(1);
    expect(stranded[0].trait).toBe('Lab');
  });
});

describe('lintWiring — app-theme-divergent', () => {
  const themedOrbital = (name: string, theme: string, path: string): Orbital => orbital({
    name,
    traits: [
      { name: `${name}Layout`, ref: 'std-app-layout#AppLayout', config: { theme: { default: theme, type: 'string' }, contentTrait: { type: 'string', default: '@trait.Content' } } },
      trait({ name: 'Content', stateMachine: { states: [], events: [], transitions: [] } }),
    ],
    pages: [{ name: `${name}Page`, path, traits: [{ ref: `${name}Layout` }, { ref: 'Content' }] }],
  });

  it('flags a page-owning orbital with no pinned theme while siblings pin one', () => {
    const bare = orbital({
      name: 'RosterOrbital',
      traits: [trait({ name: 'Directory', stateMachine: { states: [], events: [], transitions: [] } })],
      pages: [{ name: 'RosterPage', path: '/roster', traits: [{ ref: 'Directory' }] }],
    });
    const result = lintWiring(schemaOf([themedOrbital('TaskOrbital', 'linear-clean-light', '/tasks'), bare]));
    const divergent = result.findings.filter((f) => f.check === 'app-theme-divergent');
    expect(divergent).toHaveLength(1);
    expect(divergent[0]?.severity).toBe('warning');
    expect(divergent[0]?.orbital).toBe('RosterOrbital');
    expect(divergent[0]?.message).toContain('linear-clean-light');
    expect(result.errors).toBe(0);
  });

  it('flags an orbital pinning a DIFFERENT theme than the rest of the app', () => {
    const result = lintWiring(schemaOf([
      themedOrbital('TaskOrbital', 'linear-clean-light', '/tasks'),
      themedOrbital('NoteOrbital', 'linear-clean-light', '/notes'),
      themedOrbital('OddOrbital', 'terminal-dark', '/odd'),
    ]));
    const divergent = result.findings.filter((f) => f.check === 'app-theme-divergent');
    expect(divergent).toHaveLength(1);
    expect(divergent[0]?.orbital).toBe('OddOrbital');
    expect(divergent[0]?.message).toContain('terminal-dark');
  });

  it('stays silent when every page-owning orbital pins the same theme, and when nothing pins', () => {
    const coherent = lintWiring(schemaOf([
      themedOrbital('TaskOrbital', 'linear-clean-light', '/tasks'),
      themedOrbital('NoteOrbital', 'linear-clean-light', '/notes'),
    ]));
    expect(coherent.findings.filter((f) => f.check === 'app-theme-divergent')).toEqual([]);
    const unthemed = lintWiring(schemaOf([
      orbital({
        name: 'TaskOrbital',
        traits: [trait({ name: 'Content', stateMachine: { states: [], events: [], transitions: [] } })],
        pages: [{ name: 'TaskPage', path: '/tasks', traits: [{ ref: 'Content' }] }],
      }),
    ]));
    expect(unthemed.findings.filter((f) => f.check === 'app-theme-divergent')).toEqual([]);
  });
});

describe('lintWiring — orbital-config-knob-unforwarded', () => {
  const emptyStateMachine = { states: [], events: [], transitions: [] };
  const knobOrbitalEntity = { name: 'Thing', persistence: 'runtime' as const, fields: [{ name: 'id', type: 'string' as const, required: true }] };
  const forwardingTrait = (name: string, knob: string): Trait => ({
    name,
    scope: 'instance',
    config: { [knob]: { default: `@config.${knob}`, type: 'unknown' } },
    stateMachine: emptyStateMachine,
  });

  it('flags an orbital-level knob no trait forwards, alongside one that is forwarded', () => {
    const result = lintWiring({
      name: 'fixture',
      designTokens: {},
      customPatterns: {},
      orbitals: [
        {
          name: 'ListOrbital',
          entity: knobOrbitalEntity,
          pages: [],
          config: {
            pageSize: { type: 'number', default: 25 },
            orphan: { type: 'string', default: 'unused' },
          },
          traits: [forwardingTrait('BrowseList', 'pageSize')],
        },
      ],
    });
    const findings = result.findings.filter((f) => f.check === 'orbital-config-knob-unforwarded');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.orbital).toBe('ListOrbital');
    expect(findings[0]?.message).toBe(
      'Orbital "ListOrbital" declares config knob "orphan" but no trait forwards @config.orphan — ' +
        'the knob is dead (an importer can set it, nothing reads it)',
    );
  });

  it('resolves an app-level knob forwarded by a trait in ANY orbital, and flags one that is not', () => {
    const result = lintWiring({
      name: 'MyApp',
      designTokens: {},
      customPatterns: {},
      config: {
        appName: { type: 'string', default: 'Time' },
        orphanApp: { type: 'string', default: 'unused' },
      },
      orbitals: [
        { name: 'ShellOrbital', entity: knobOrbitalEntity, pages: [], traits: [forwardingTrait('AppLayout', 'appName')] },
        { name: 'OtherOrbital', entity: knobOrbitalEntity, pages: [], traits: [{ name: 'Plain', scope: 'instance', stateMachine: emptyStateMachine }] },
      ],
    });
    const findings = result.findings.filter((f) => f.check === 'orbital-config-knob-unforwarded');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.orbital).toBe('MyApp');
    expect(findings[0]?.message).toBe(
      'App "MyApp" declares config knob "orphanApp" but no trait forwards @config.orphanApp — ' +
        'the knob is dead (an importer can set it, nothing reads it)',
    );
  });

  it('resolves an app knob forwarded THROUGH an imported orbital knob (forwardedFrom chain), and flags a broken chain', () => {
    const chained = (withTrait: boolean) => lintWiring({
      name: 'MyApp',
      designTokens: {},
      customPatterns: {},
      config: { googleCalendarId: { type: 'string', default: '' } },
      orbitals: [
        {
          name: 'TaskOrbital',
          entity: knobOrbitalEntity,
          pages: [],
          config: { calendarId: { type: 'string', default: '', forwardedFrom: '@config.googleCalendarId' } },
          traits: withTrait
            ? [{
                name: 'CalendarSync',
                scope: 'instance',
                config: { calendarId: { default: '', type: 'unknown', forwardedFrom: '@config.calendarId' } },
                stateMachine: emptyStateMachine,
              }]
            : [{ name: 'Plain', scope: 'instance', stateMachine: emptyStateMachine }],
        },
      ],
    });
    const forwarded = chained(true).findings.filter((f) => f.check === 'orbital-config-knob-unforwarded');
    expect(forwarded).toEqual([]);
    const broken = chained(false).findings.filter((f) => f.check === 'orbital-config-knob-unforwarded');
    expect(broken.map((f) => f.orbital).sort()).toEqual(['MyApp', 'TaskOrbital']);
  });

  it('does not count a dotted @config.knob.sub default as a forward', () => {
    const result = lintWiring({
      name: 'fixture',
      designTokens: {},
      customPatterns: {},
      orbitals: [
        {
          name: 'ListOrbital',
          entity: knobOrbitalEntity,
          pages: [],
          config: { columns: { type: 'array', default: [] } },
          traits: [forwardingTrait('BrowseList', 'columns.width')],
        },
      ],
    });
    const findings = result.findings.filter((f) => f.check === 'orbital-config-knob-unforwarded');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('"columns"');
  });

  it('does not flag a resolved forward carrying forwardedFrom provenance (no @config token left)', () => {
    const result = lintWiring({
      name: 'fixture',
      designTokens: {},
      customPatterns: {},
      orbitals: [
        {
          name: 'ListOrbital',
          entity: knobOrbitalEntity,
          pages: [],
          config: { pageSize: { type: 'number', default: 25 } },
          traits: [
            {
              name: 'BrowseList',
              scope: 'instance',
              config: { pageSize: { default: 25, type: 'number', forwardedFrom: '@config.pageSize' } },
              stateMachine: emptyStateMachine,
            },
          ],
        },
      ],
    });
    const findings = result.findings.filter((f) => f.check === 'orbital-config-knob-unforwarded');
    expect(findings).toEqual([]);
  });

  it('flags a resolved knob with neither the @config token nor forwardedFrom provenance', () => {
    const result = lintWiring({
      name: 'fixture',
      designTokens: {},
      customPatterns: {},
      orbitals: [
        {
          name: 'ListOrbital',
          entity: knobOrbitalEntity,
          pages: [],
          config: { pageSize: { type: 'number', default: 25 } },
          traits: [
            {
              name: 'BrowseList',
              scope: 'instance',
              config: { pageSize: { default: 25, type: 'number' } },
              stateMachine: emptyStateMachine,
            },
          ],
        },
      ],
    });
    const findings = result.findings.filter((f) => f.check === 'orbital-config-knob-unforwarded');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('"pageSize"');
  });

  it('stays silent for a schema with no config anywhere', () => {
    const result = lintWiring({
      name: 'fixture',
      designTokens: {},
      customPatterns: {},
      orbitals: [
        {
          name: 'PlainOrbital',
          entity: knobOrbitalEntity,
          pages: [],
          traits: [{ name: 'Content', scope: 'instance', stateMachine: emptyStateMachine }],
        },
      ],
    });
    expect(result.findings.filter((f) => f.check === 'orbital-config-knob-unforwarded')).toEqual([]);
  });
});

describe('lintWiring — identity-roster-unwritable', () => {
  const identityEntity: Entity = {
    name: 'Staff',
    collection: 'staff',
    persistence: 'persistent',
    identity: true,
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'name', type: 'string', required: true },
    ],
  };

  it('flags an [identity] entity no transition persist-creates', () => {
    const result = lintWiring(schemaOf([
      orbital({
        name: 'StaffOrbital',
        entity: identityEntity,
        traits: [
          trait({
            name: 'Directory',
            stateMachine: { states: [], events: [], transitions: [{ from: 'idle', event: 'INIT', to: 'idle', effects: [['fetch', 'Staff', {}]] }] },
          }),
        ],
        pages: [{ name: 'StaffPage', path: '/staff', traits: [{ ref: 'Directory' }] }],
      }),
    ]));
    const unwritable = result.findings.filter((f) => f.check === 'identity-roster-unwritable');
    expect(unwritable).toHaveLength(1);
    expect(unwritable[0]?.severity).toBe('warning');
    expect(unwritable[0]?.entity).toBe('Staff');
    expect(unwritable[0]?.orbital).toBe('StaffOrbital');
  });

  it('stays silent once a persistor arm reaches persist create — including nested in an if', () => {
    const result = lintWiring(schemaOf([
      orbital({
        name: 'StaffOrbital',
        entity: identityEntity,
        traits: [
          trait({
            name: 'Persistor',
            stateMachine: {
              states: [], events: [],
              transitions: [
                {
                  from: 'idle',
                  event: 'DO_CREATE',
                  to: 'idle',
                  effects: [['if', ['=', 1, 1], ['persist', 'create', 'Staff', '@payload.data', { emit: { success: 'STAFF_CREATED' } }]]],
                },
              ],
            },
          }),
        ],
        pages: [{ name: 'StaffPage', path: '/staff', traits: [{ ref: 'Persistor' }] }],
      }),
    ]));
    expect(result.findings.filter((f) => f.check === 'identity-roster-unwritable')).toEqual([]);
  });

  it('stays silent when the only persist is an UPDATE — a roster row seeded by auth, edited via persist update (the std-realtime-chat OnlinePresence shape)', () => {
    const result = lintWiring(schemaOf([
      orbital({
        name: 'StaffOrbital',
        entity: identityEntity,
        traits: [
          trait({
            name: 'OnlinePresence',
            stateMachine: {
              states: [], events: [],
              transitions: [
                {
                  from: 'idle',
                  event: 'MARK_ONLINE',
                  to: 'idle',
                  effects: [['persist', 'update', 'Staff', '@payload.data']],
                },
              ],
            },
          }),
        ],
        pages: [{ name: 'StaffPage', path: '/staff', traits: [{ ref: 'OnlinePresence' }] }],
      }),
    ]));
    expect(result.findings.filter((f) => f.check === 'identity-roster-unwritable')).toEqual([]);
  });

  it('stays silent for an app with no [identity] entity', () => {
    const result = lintWiring(schemaOf([
      orbital({
        name: 'TaskOrbital',
        entity: { name: 'Task', collection: 'tasks', fields: [{ name: 'id', type: 'string', required: true }] },
        traits: [trait({ name: 'Content', stateMachine: { states: [], events: [], transitions: [] } })],
        pages: [{ name: 'TaskPage', path: '/tasks', traits: [{ ref: 'Content' }] }],
      }),
    ]));
    expect(result.findings.filter((f) => f.check === 'identity-roster-unwritable')).toEqual([]);
  });
});

describe('lintWiring — app-theme-divergent with a schema-level theme', () => {
  const pinnedOrbital = (name: string, path: string, pin?: string): Orbital => orbital({
    name,
    traits: [
      {
        name: `${name}Layout`,
        ref: 'std-app-layout#AppLayout',
        config: pin !== undefined ? { theme: { default: pin, type: 'string' } } : {},
      },
      trait({ name: 'Content', stateMachine: { states: [], events: [], transitions: [] } }),
    ],
    pages: [{ name: `${name}Page`, path, traits: [{ ref: `${name}Layout` }, { ref: 'Content' }] }],
  });

  it('treats unpinned orbitals as clean when the app declares a theme', () => {
    const result = lintWiring({
      name: 'fixture',
      theme: 'linear-clean-light',
      orbitals: [pinnedOrbital('TaskOrbital', '/tasks', 'linear-clean-light'), pinnedOrbital('RosterOrbital', '/roster')],
    });
    expect(result.findings.filter((f) => f.check === 'app-theme-divergent')).toEqual([]);
  });

  it('flags a config pin contradicting the app theme', () => {
    const result = lintWiring({
      name: 'fixture',
      theme: 'linear-clean-light',
      orbitals: [pinnedOrbital('TaskOrbital', '/tasks'), pinnedOrbital('OddOrbital', '/odd', 'terminal-dark')],
    });
    const divergent = result.findings.filter((f) => f.check === 'app-theme-divergent');
    expect(divergent).toHaveLength(1);
    expect(divergent[0]?.orbital).toBe('OddOrbital');
    expect(divergent[0]?.message).toContain('terminal-dark');
    expect(divergent[0]?.message).toContain('linear-clean-light');
  });

  it('keeps the dominant-vote behavior when no app theme is declared', () => {
    const result = lintWiring(schemaOf([pinnedOrbital('TaskOrbital', '/tasks', 'linear-clean-light'), pinnedOrbital('RosterOrbital', '/roster')]));
    const divergent = result.findings.filter((f) => f.check === 'app-theme-divergent');
    expect(divergent).toHaveLength(1);
    expect(divergent[0]?.orbital).toBe('RosterOrbital');
  });
});

describe('lintWiring — navigate-target-undeclared', () => {
  const navigateTrait = (target: string | SExpr): Trait => trait({
    name: 'Row',
    stateMachine: {
      states: [], events: [],
      transitions: [{ from: 'idle', event: 'OPEN', to: 'idle', effects: [['navigate', target]] }],
    },
  });
  const navigateWithParams = (target: string | SExpr): Trait => trait({
    name: 'Row',
    stateMachine: {
      states: [], events: [],
      transitions: [
        { from: 'idle', event: 'OPEN', to: 'idle', effects: [['navigate', target, { id: '@payload.id' }]] },
      ],
    },
  });

  it('flags a navigate to a path no page in the app declares (the 404 class)', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'ContactsOrbital',
        traits: [navigateTrait('/staff-directory')],
        pages: [{ name: 'ContactsPage', path: '/contacts', traits: [{ ref: 'Row' }] }],
      })),
    );
    const found = result.findings.filter((f) => f.check === 'navigate-target-undeclared');
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe('warning');
    expect(found[0]?.trait).toBe('Row');
    expect(found[0]?.message).toContain("'/staff-directory'");
  });

  it('is clean on an exact literal match', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'ContactsOrbital',
        traits: [navigateTrait('/contacts')],
        pages: [{ name: 'ContactsPage', path: '/contacts', traits: [{ ref: 'Row' }] }],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'navigate-target-undeclared')).toEqual([]);
  });

  it('matches a concrete path against a declared :param page positionally', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'ContactsOrbital',
        traits: [navigateWithParams('/contacts/abc123')],
        pages: [
          { name: 'ContactsPage', path: '/contacts', traits: [{ ref: 'Row' }] },
          { name: 'ContactDetailPage', path: '/contacts/:id', traits: [{ ref: 'Row' }] },
        ],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'navigate-target-undeclared')).toEqual([]);
  });

  it('matches a str/concat-built target by its literal prefix against a :param-stripped page path', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'ContactsOrbital',
        traits: [navigateWithParams(['str/concat', '/contacts/', '@payload.id'])],
        pages: [{ name: 'ContactDetailPage', path: '/contacts/:id', traits: [{ ref: 'Row' }] }],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'navigate-target-undeclared')).toEqual([]);
  });

  it('flags a str/concat-built target whose prefix matches no declared page', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'ContactsOrbital',
        traits: [navigateWithParams(['str/concat', '/vendors/', '@payload.id'])],
        pages: [{ name: 'ContactDetailPage', path: '/contacts/:id', traits: [{ ref: 'Row' }] }],
      })),
    );
    const found = result.findings.filter((f) => f.check === 'navigate-target-undeclared');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('/vendors/');
  });

  it('does not guess at a fully dynamic binding target (no literal information)', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'ContactsOrbital',
        traits: [navigateTrait('@config.redirectUrl')],
        pages: [{ name: 'ContactsPage', path: '/contacts', traits: [{ ref: 'Row' }] }],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'navigate-target-undeclared')).toEqual([]);
  });

  it('resolves against pages declared in a SIBLING orbital (cross-orbital declared-path universe)', () => {
    const result = lintWiring(schemaOf([
      orbital({
        name: 'DashboardOrbital',
        traits: [navigateTrait('/reports')],
        pages: [{ name: 'DashboardPage', path: '/dashboard', traits: [{ ref: 'Row' }] }],
      }),
      orbital({
        name: 'ReportsOrbital',
        traits: [trait({ name: 'Reports', stateMachine: { states: [], events: [], transitions: [] } })],
        pages: [{ name: 'ReportsPage', path: '/reports', traits: [{ ref: 'Reports' }] }],
      }),
    ]));
    expect(result.findings.filter((f) => f.check === 'navigate-target-undeclared')).toEqual([]);
  });
});

describe('lintWiring — page-absent-from-nav', () => {
  const layoutWithNavItems = (items: ReadonlyArray<{ href: string; label: string }>): Trait => trait({
    name: 'AppLayout',
    config: { navItems: { type: 'array', default: [...items] } },
    stateMachine: { states: [], events: [], transitions: [] },
  });

  it('flags a declared page reachable by no navItems array in the app (the ATS /staff class)', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'StaffOrbital',
        traits: [layoutWithNavItems([{ href: '/dashboard', label: 'Dashboard' }])],
        pages: [
          { name: 'DashboardPage', path: '/dashboard', traits: [{ ref: 'AppLayout' }] },
          { name: 'StaffPage', path: '/staff', traits: [{ ref: 'AppLayout' }] },
        ],
      })),
    );
    const found = result.findings.filter((f) => f.check === 'page-absent-from-nav');
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe('warning');
    expect(found[0]?.message).toContain("'/staff'");
  });

  it('is clean once the page has an entry in a navItems array', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'StaffOrbital',
        traits: [layoutWithNavItems([{ href: '/dashboard', label: 'Dashboard' }, { href: '/staff', label: 'Staff' }])],
        pages: [
          { name: 'DashboardPage', path: '/dashboard', traits: [{ ref: 'AppLayout' }] },
          { name: 'StaffPage', path: '/staff', traits: [{ ref: 'AppLayout' }] },
        ],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'page-absent-from-nav')).toEqual([]);
  });

  it('does not flag a parameterized detail page (structurally reached by row click, not a nav link)', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'StaffOrbital',
        traits: [layoutWithNavItems([{ href: '/staff', label: 'Staff' }])],
        pages: [
          { name: 'StaffPage', path: '/staff', traits: [{ ref: 'AppLayout' }] },
          { name: 'StaffDetailPage', path: '/staff/:id', traits: [{ ref: 'AppLayout' }] },
        ],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'page-absent-from-nav')).toEqual([]);
  });

  it('does not flag the app root page', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'StaffOrbital',
        traits: [layoutWithNavItems([])],
        pages: [{ name: 'HomePage', path: '/', traits: [{ ref: 'AppLayout' }] }],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'page-absent-from-nav')).toEqual([]);
  });

  it('stays silent for an app with no navItems array anywhere (has not opted into the convention)', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'StaffOrbital',
        traits: [{ name: 'Directory', scope: 'instance', stateMachine: { states: [], events: [],  transitions: [] } }],
        pages: [{ name: 'StaffPage', path: '/staff', traits: [{ ref: 'Directory' }] }],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'page-absent-from-nav')).toEqual([]);
  });
});

describe('lintWiring — page-path-duplicate', () => {
  const layout = trait({ name: 'Layout', scope: 'instance', stateMachine: { states: [], events: [],  transitions: [] } });

  it('flags two pages whose paths collide once the param NAME is normalized away (/x/:id vs /x/:slug)', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'CatalogOrbital',
        traits: [layout],
        pages: [
          { name: 'ItemById', path: '/x/:id', traits: [{ ref: 'Layout' }] },
          { name: 'ItemBySlug', path: '/x/:slug', traits: [{ ref: 'Layout' }] },
        ],
      })),
    );
    const found = result.findings.filter((f) => f.check === 'page-path-duplicate');
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe('warning');
    expect(found[0]?.message).toContain("'/x/:id'");
    expect(found[0]?.message).toContain("'/x/:slug'");
    expect(found[0]?.message).toContain('CatalogOrbital.ItemById');
    expect(found[0]?.message).toContain('CatalogOrbital.ItemBySlug');
  });

  it('does not flag pages whose param segment sits at a different position (/x/:id vs /y/:id)', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'CatalogOrbital',
        traits: [layout],
        pages: [
          { name: 'ItemById', path: '/x/:id', traits: [{ ref: 'Layout' }] },
          { name: 'OtherById', path: '/y/:id', traits: [{ ref: 'Layout' }] },
        ],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'page-path-duplicate')).toEqual([]);
  });

  it('flags an exact duplicate path once', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'CatalogOrbital',
        traits: [layout],
        pages: [
          { name: 'ItemA', path: '/x/y', traits: [{ ref: 'Layout' }] },
          { name: 'ItemB', path: '/x/y', traits: [{ ref: 'Layout' }] },
        ],
      })),
    );
    const found = result.findings.filter((f) => f.check === 'page-path-duplicate');
    expect(found).toHaveLength(1);
  });

  it('does not flag a single declared page', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'CatalogOrbital',
        traits: [layout],
        pages: [{ name: 'ItemById', path: '/x/:id', traits: [{ ref: 'Layout' }] }],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'page-path-duplicate')).toEqual([]);
  });
});

describe('lintWiring — relation-field-rendered-raw', () => {
  const mainRender = (pattern: AnyPatternConfig): Effect => ['render-ui', 'main', pattern];
  const ticketEntity: Entity = {
    name: 'Ticket',
    persistence: 'persistent',
    collection: 'tickets',
    fields: [
      { name: 'id', type: 'string' },
      { name: 'title', type: 'string' },
      { name: 'assigneeId', type: 'relation', relation: { entity: 'Staff' } },
    ],
  };
  const tableTrait = (columnEntry: Record<string, unknown>, extra: Record<string, unknown> = {}): Trait => trait({
    name: 'TicketTable',
    linkedEntity: 'Ticket',
    stateMachine: {
      states: [], events: [],
      transitions: [
        {
          from: 'browsing',
          event: 'INIT',
          to: 'browsing',
          effects: [
            mainRender({
              type: 'entity-table',
              entity: '@entity.rows',
              fields: [{ key: 'title' }, { key: 'assigneeId' }],
              columns: [{ key: 'title' }, columnEntry],
              ...extra,
            }),
          ],
        },
      ],
    },
  });
  const schema = (columnEntry: Record<string, unknown>, extra: Record<string, unknown> = {}): OrbitalSchema => ({
    name: 'fixture',
    orbitals: [
      orbital({
        name: 'TicketOrbital',
        entity: ticketEntity,
        traits: [tableTrait(columnEntry, extra)],
        pages: [{ name: 'TicketsPage', path: '/tickets', traits: [{ ref: 'TicketTable' }] }],
      }),
    ],
  });

  it('flags a relation-typed column with no type/format override and no relationsData', () => {
    const result = lintWiring(schema({ key: 'assigneeId', field: 'assigneeId', header: 'Assignee' }));
    const found = result.findings.filter((f) => f.check === 'relation-field-rendered-raw');
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe('warning');
    expect(found[0]?.trait).toBe('TicketTable');
    expect(found[0]?.message).toContain('assigneeId');
  });

  it('is silent once the column carries a format override', () => {
    const result = lintWiring(schema({ key: 'assigneeId', format: 'relation-label' }));
    expect(result.findings.filter((f) => f.check === 'relation-field-rendered-raw')).toEqual([]);
  });

  it('is silent once the pattern carries authored relationsData', () => {
    const result = lintWiring(
      schema({ key: 'assigneeId' }, { relationsData: { assigneeId: [{ value: 's1', label: 'Jo' }] } }),
    );
    expect(result.findings.filter((f) => f.check === 'relation-field-rendered-raw')).toEqual([]);
  });

  it('is silent on a non-relation column key', () => {
    const result = lintWiring(schema({ key: 'title' }));
    expect(result.findings.filter((f) => f.check === 'relation-field-rendered-raw')).toEqual([]);
  });

  it('never fires on detail-panel/form/form-section — those get server-side relationsData auto-injection', () => {
    // `columns` isn't a declared `detail-panel` prop — held in a variable
    // (not a fresh literal) so the excess property lands as a genuine extra
    // field, proving the exclusion is by @fieldsContract, not by absence of
    // `columns`.
    const node = {
      type: 'detail-panel' as const,
      fields: [{ key: 'title' }, { key: 'assigneeId' }],
      columns: [{ key: 'assigneeId' }],
    };
    const result = lintWiring(schemaOf([
      orbital({
        name: 'TicketOrbital',
        entity: ticketEntity,
        traits: [
          trait({
            name: 'TicketDetail',
            linkedEntity: 'Ticket',
            stateMachine: {
              states: [], events: [],
              transitions: [
                {
                  from: 'viewing',
                  event: 'INIT',
                  to: 'viewing',
                  effects: [mainRender(node)],
                },
              ],
            },
          }),
        ],
        pages: [{ name: 'TicketPage', path: '/tickets/:id', traits: [{ ref: 'TicketDetail' }] }],
      }),
    ]));
    expect(result.findings.filter((f) => f.check === 'relation-field-rendered-raw')).toEqual([]);
  });
});

describe('lintWiring — modal-shell-close-deaf', () => {
  const overlayTrait = (name: string, targetArms: Transition[]): Trait => trait({
    name,
    stateMachine: {
      states: [], events: [],
      transitions: [
        { from: 'idle', event: 'OPEN', to: 'open', effects: [MODAL_RENDER] },
        ...targetArms,
      ],
    },
  });

  it('flags the std-realtime-chat ChatOverlayPanel shape: stack into modal, target state handles neither CLOSE nor CANCEL', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'ChatOrbital',
        traits: [overlayTrait('ChatOverlayPanel', [])],
        pages: [{ name: 'ChatPage', path: '/chat', traits: [{ ref: 'ChatOverlayPanel' }] }],
      })),
    );
    const found = result.findings.filter((f) => f.check === 'modal-shell-close-deaf');
    expect(found).toHaveLength(1);
    expect(found[0]?.trait).toBe('ChatOverlayPanel');
    expect(found[0]?.severity).toBe('warning');
    expect(found[0]?.message).toContain('CLOSE');
  });

  it('is silent once the target state handles CLOSE', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'ChatOrbital',
        traits: [overlayTrait('ChatOverlayPanel', [{ from: 'open', event: 'CLOSE', to: 'idle', effects: [] }])],
        pages: [{ name: 'ChatPage', path: '/chat', traits: [{ ref: 'ChatOverlayPanel' }] }],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'modal-shell-close-deaf')).toEqual([]);
  });

  it('is silent once the target state handles CANCEL', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'ChatOrbital',
        traits: [overlayTrait('ChatOverlayPanel', [{ from: 'open', event: 'CANCEL', to: 'idle', effects: [] }])],
        pages: [{ name: 'ChatPage', path: '/chat', traits: [{ ref: 'ChatOverlayPanel' }] }],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'modal-shell-close-deaf')).toEqual([]);
  });

  it('is silent for a self-overlay pattern type (modal) — it paints its own chrome', () => {
    const selfOverlayRender: Effect = ['render-ui', 'modal', { type: 'modal', title: 'Confirm' }];
    const result = lintWiring(
      schemaWith(orbital({
        name: 'ChatOrbital',
        traits: [
          trait({
            name: 'ConfirmDialogHost',
            stateMachine: {
              states: [], events: [],
              transitions: [{ from: 'idle', event: 'OPEN', to: 'open', effects: [selfOverlayRender] }],
            },
          }),
        ],
        pages: [{ name: 'ChatPage', path: '/chat', traits: [{ ref: 'ConfirmDialogHost' }] }],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'modal-shell-close-deaf')).toEqual([]);
  });

  it('is silent for a render into "main" — only overlay slots (modal/drawer) get the shell', () => {
    const mainRenderEffect: Effect = ['render-ui', 'main', { type: 'stack', children: [] }];
    const result = lintWiring(
      schemaWith(orbital({
        name: 'ChatOrbital',
        traits: [
          trait({
            name: 'MainContent',
            stateMachine: {
              states: [], events: [],
              transitions: [{ from: 'idle', event: 'INIT', to: 'idle', effects: [mainRenderEffect] }],
            },
          }),
        ],
        pages: [{ name: 'ChatPage', path: '/chat', traits: [{ ref: 'MainContent' }] }],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'modal-shell-close-deaf')).toEqual([]);
  });
});

describe('lintWiring — filter-field-never-written', () => {
  const chatMessageEntity: Entity = {
    name: 'ChatMessage',
    collection: 'chat_messages',
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'channel', type: 'string' },
      { name: 'content', type: 'string' },
      { name: 'threadRootId', type: 'string' },
    ],
  };

  const threadFilterFetch: Effect = [
    'fetch',
    'ChatMessage',
    { filter: ['=', ['object/get', '@entity', 'threadRootId'], '@config.threadRootId'] },
  ];

  const channelThread = trait({
    name: 'ChannelThread',
    stateMachine: {
      states: [], events: [],
      transitions: [{ from: 'idle', event: 'INIT', to: 'idle', effects: [threadFilterFetch] }],
    },
  });

  it('flags the std-realtime-chat ChannelThread shape: filter on a field no persist ever writes', () => {
    const result = lintWiring(
      schemaWith(orbital({
        name: 'ChatOrbital',
        entity: chatMessageEntity,
        traits: [channelThread],
        pages: [{ name: 'ChatPage', path: '/chat', traits: [{ ref: 'ChannelThread' }] }],
      })),
    );
    const found = result.findings.filter((f) => f.check === 'filter-field-never-written');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('threadRootId');
    expect(found[0]?.severity).toBe('warning');
  });

  it('is silent once a persist create supplies the filtered key (explicit object-literal data)', () => {
    const composer = trait({
      name: 'ChatComposer',
      stateMachine: {
        states: [], events: [],
        transitions: [
          {
            from: 'ready',
            event: 'SEND',
            to: 'ready',
            effects: [['persist', 'create', 'ChatMessage', { content: '@entity.draft', threadRootId: '@entity.threadRoot' }]],
          },
        ],
      },
    });
    const result = lintWiring(
      schemaWith(orbital({
        name: 'ChatOrbital',
        entity: chatMessageEntity,
        traits: [channelThread, composer],
        pages: [{ name: 'ChatPage', path: '/chat', traits: [{ ref: 'ChannelThread' }, { ref: 'ChatComposer' }] }],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'filter-field-never-written')).toEqual([]);
  });

  it('is silent when the persist data argument is bare (@entity — may supply any field)', () => {
    const composer = trait({
      name: 'ChatComposer',
      stateMachine: {
        states: [], events: [],
        transitions: [
          { from: 'ready', event: 'SEND', to: 'ready', effects: [['persist', 'create', 'ChatMessage', '@entity']] },
        ],
      },
    });
    const result = lintWiring(
      schemaWith(orbital({
        name: 'ChatOrbital',
        entity: chatMessageEntity,
        traits: [channelThread, composer],
        pages: [{ name: 'ChatPage', path: '/chat', traits: [{ ref: 'ChannelThread' }, { ref: 'ChatComposer' }] }],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'filter-field-never-written')).toEqual([]);
  });

  it('is silent when the filtered field selector is itself dynamic (std-browse scopeField/?field shape)', () => {
    // The std-realtime-chat corpus run surfaced this as a real bug: a
    // config-forwarded field selector (`@config.scopeField`) that resolves
    // to "" at an unconfigured call site, or a payload-bound selector
    // (`?field`) left literal, must NOT be read as a literal field name —
    // either misreads as "field ''" or "field '?field'", not a real finding.
    const dynamicFieldFetch = trait({
      name: 'GenericBrowse',
      stateMachine: {
        states: [], events: [],
        transitions: [
          {
            from: 'idle',
            event: 'REFETCH_FILTER',
            to: 'idle',
            effects: [
              ['fetch', 'ChatMessage', { filter: ['=', ['object/get', '@entity', '?field'], '?value'] }],
              ['fetch', 'ChatMessage', { filter: ['=', ['object/get', '@entity', ''], ''] }],
            ],
          },
        ],
      },
    });
    const result = lintWiring(
      schemaWith(orbital({
        name: 'ChatOrbital',
        entity: chatMessageEntity,
        traits: [dynamicFieldFetch],
        pages: [{ name: 'ChatPage', path: '/chat', traits: [{ ref: 'GenericBrowse' }] }],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'filter-field-never-written')).toEqual([]);
  });

  it('is silent for an [identity] entity — its rows come from the auth roster, not a persist in this program', () => {
    // The std-realtime-chat corpus run surfaced this as a false-positive
    // class: OnlineUser is the app's [identity] roster (read-only, per the
    // sibling identity-roster-unwritable finding) — no persist create/update
    // ever supplies ANY field on it, by design, so "no persist supplies
    // `name`" proves nothing here.
    const onlineUserEntity: Entity = {
      name: 'OnlineUser',
      collection: 'online_users',
      identity: true,
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'name', type: 'string' },
        { name: 'username', type: 'string' },
      ],
    };
    const search = trait({
      name: 'OnlineUserSearch',
      stateMachine: {
        states: [], events: [],
        transitions: [
          {
            from: 'idle',
            event: 'SEARCH',
            to: 'idle',
            effects: [
              ['fetch', 'OnlineUser', { filter: ['=', ['object/get', '@entity', 'name'], '?term'] }],
            ],
          },
        ],
      },
    });
    const result = lintWiring(
      schemaWith(orbital({
        name: 'OnlineUserOrbital',
        entity: onlineUserEntity,
        traits: [search],
        pages: [{ name: 'OnlinePage', path: '/online', traits: [{ ref: 'OnlineUserSearch' }] }],
      })),
    );
    expect(result.findings.filter((f) => f.check === 'filter-field-never-written')).toEqual([]);
  });

  it('is silent when a DIFFERENT entity sharing the same persistent: collection supplies the field (std-cms HubArticle/Article shape)', () => {
    // HubArticle is CmsHubOrbital's read-only "view" of the SAME `articles`
    // collection Article (a sibling orbital's own entity, composed from a
    // different atom) actually writes — no persist ever targets `HubArticle`
    // by name, but the collection is provably supplied.
    const hubArticleEntity: Entity = {
      name: 'HubArticle',
      collection: 'articles',
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'title', type: 'string' },
      ],
    };
    const articleEntity: Entity = {
      name: 'Article',
      collection: 'articles',
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'title', type: 'string' },
      ],
    };
    const hubSearch = trait({
      name: 'CmsHubSearch',
      stateMachine: {
        states: [], events: [],
        transitions: [
          {
            from: 'idle',
            event: 'SEARCH',
            to: 'idle',
            effects: [['fetch', 'HubArticle', { filter: ['=', ['object/get', '@entity', 'title'], '?term'] }]],
          },
        ],
      },
    });
    const articlePersistor = trait({
      name: 'ArticlePersistor',
      stateMachine: {
        states: [], events: [],
        transitions: [
          {
            from: 'idle',
            event: 'DO_CREATE_DRAFT',
            to: 'idle',
            effects: [['persist', 'create', 'Article', { title: '@config.draftTitle' }]],
          },
        ],
      },
    });
    const result = lintWiring(
      schemaOf([
        orbital({
          name: 'CmsHubOrbital',
          entity: hubArticleEntity,
          traits: [hubSearch],
          pages: [{ name: 'HubPage', path: '/cms-hub', traits: [{ ref: 'CmsHubSearch' }] }],
        }),
        orbital({
          name: 'ArticleOrbital',
          entity: articleEntity,
          traits: [articlePersistor],
          pages: [{ name: 'ArticlePage', path: '/articles', traits: [{ ref: 'ArticlePersistor' }] }],
        }),
      ]),
    );
    expect(result.findings.filter((f) => f.check === 'filter-field-never-written')).toEqual([]);
  });

  it('still flags a collection-sharing entity when NO entity on that collection writes the field', () => {
    const hubArticleEntity: Entity = {
      name: 'HubArticle',
      collection: 'articles',
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'title', type: 'string' },
      ],
    };
    const articleEntity: Entity = {
      name: 'Article',
      collection: 'articles',
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'title', type: 'string' },
      ],
    };
    const hubSearch = trait({
      name: 'CmsHubSearch',
      stateMachine: {
        states: [], events: [],
        transitions: [
          {
            from: 'idle',
            event: 'SEARCH',
            to: 'idle',
            effects: [['fetch', 'HubArticle', { filter: ['=', ['object/get', '@entity', 'title'], '?term'] }]],
          },
        ],
      },
    });
    const articlePersistor = trait({
      name: 'ArticlePersistor',
      stateMachine: {
        states: [], events: [],
        transitions: [
          {
            from: 'idle',
            event: 'DO_CREATE_DRAFT',
            to: 'idle',
            // Supplies `id`, never `title` — the collection mate exists but
            // still never writes the filtered field.
            effects: [['persist', 'create', 'Article', { id: '@payload.id' }]],
          },
        ],
      },
    });
    const result = lintWiring(
      schemaOf([
        orbital({
          name: 'CmsHubOrbital',
          entity: hubArticleEntity,
          traits: [hubSearch],
          pages: [{ name: 'HubPage', path: '/cms-hub', traits: [{ ref: 'CmsHubSearch' }] }],
        }),
        orbital({
          name: 'ArticleOrbital',
          entity: articleEntity,
          traits: [articlePersistor],
          pages: [{ name: 'ArticlePage', path: '/articles', traits: [{ ref: 'ArticlePersistor' }] }],
        }),
      ]),
    );
    const found = result.findings.filter((f) => f.check === 'filter-field-never-written');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('title');
  });
});

describe('lintWiring — failure-arm-missing / failure-arm-renders-nothing', () => {
  const persistorTrait = (targetArms: Transition[]): Trait => trait({
    name: 'CartItemPersistor',
    stateMachine: {
      states: [], events: [],
      transitions: [
        {
          from: 'idle',
          event: 'SAVE',
          to: 'saving',
          effects: [['persist', 'create', 'CartItem', { name: '@payload.name' }, { emit: { success: 'CartItemSaved', failure: 'CartItemSaveFailed' } }]],
        },
        ...targetArms,
      ],
    },
  });

  const schemaFor = (targetArms: Transition[]): OrbitalSchema => schemaWith(orbital({
    name: 'CartOrbital',
    traits: [persistorTrait(targetArms)],
    pages: [{ name: 'CartPage', path: '/cart', traits: [{ ref: 'CartItemPersistor' }] }],
  }));

  it('flags failure-arm-missing when no arm anywhere handles the declared failure event', () => {
    const result = lintWiring(schemaFor([]));
    const found = result.findings.filter((f) => f.check === 'failure-arm-missing');
    expect(found).toHaveLength(1);
    expect(found[0]?.trait).toBe('CartItemPersistor');
    expect(found[0]?.severity).toBe('error');
    expect(found[0]?.message).toContain('CartItemSaveFailed');
    expect(result.findings.filter((f) => f.check === 'failure-arm-renders-nothing')).toEqual([]);
  });

  it('flags failure-arm-renders-nothing when the arm exists but renders and notifies nothing', () => {
    const result = lintWiring(schemaFor([
      { from: 'saving', event: 'CartItemSaveFailed', to: 'idle', effects: [] },
    ]));
    expect(result.findings.filter((f) => f.check === 'failure-arm-missing')).toEqual([]);
    const found = result.findings.filter((f) => f.check === 'failure-arm-renders-nothing');
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe('warning');
    expect(found[0]?.message).toContain('CartItemSaveFailed');
  });

  it('is silent once the arm paints a toast (notify sugar)', () => {
    const toastEffect: Effect = ['render-ui', 'toast', { type: 'alert', variant: 'error', message: 'Could not save item', dismissible: true }];
    const result = lintWiring(schemaFor([
      { from: 'saving', event: 'CartItemSaveFailed', to: 'idle', effects: [toastEffect] },
    ]));
    expect(result.findings.filter((f) => f.check === 'failure-arm-missing')).toEqual([]);
    expect(result.findings.filter((f) => f.check === 'failure-arm-renders-nothing')).toEqual([]);
  });

  it('is silent once the arm renders a non-null pattern into a slot', () => {
    const toastRender: Effect = ['render-ui', 'toast', { type: 'alert', message: 'Could not save item' }];
    const result = lintWiring(schemaFor([
      { from: 'saving', event: 'CartItemSaveFailed', to: 'idle', effects: [toastRender] },
    ]));
    expect(result.findings.filter((f) => f.check === 'failure-arm-missing')).toEqual([]);
    expect(result.findings.filter((f) => f.check === 'failure-arm-renders-nothing')).toEqual([]);
  });

  it('is silent for a trait not bound to any page', () => {
    const schema = schemaWith(orbital({
      name: 'CartOrbital',
      traits: [persistorTrait([])],
      pages: [{ name: 'CartPage', path: '/cart', traits: [] }],
    }));
    const result = lintWiring(schema);
    expect(result.findings.filter((f) => f.check === 'failure-arm-missing')).toEqual([]);
    expect(result.findings.filter((f) => f.check === 'failure-arm-renders-nothing')).toEqual([]);
  });
});
