import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { lintWiring } from '../wiring-lint.js';

/** Minimal resolved-schema builder around one orbital. */
function schemaWith(orbital: Record<string, unknown>): OrbitalSchema {
  return { name: 'fixture', orbitals: [orbital] } as unknown as OrbitalSchema;
}

const MODAL_RENDER = [
  'render-ui',
  'modal',
  { type: 'stack', children: ['@trait.RemoveIcon', '@trait.RemoveAlert'] },
];

describe('lintWiring — client-unbound-state-machine', () => {
  const removeConfirm = {
    name: 'RemoveConfirm',
    stateMachine: {
      transitions: [
        { from: 'idle', event: 'REQUEST_REMOVE', to: 'confirming', effects: [MODAL_RENDER] },
        { from: 'confirming', event: 'CONFIRM_REMOVE', to: 'idle', effects: [] },
      ],
    },
    listens: [
      { event: 'REQUEST_REMOVE', triggers: 'REQUEST_REMOVE', source: { kind: 'trait', trait: 'Browse' } },
    ],
  };
  const browse = {
    name: 'Browse',
    stateMachine: { transitions: [{ from: 'browsing', event: 'INIT', to: 'browsing', effects: [] }] },
    emits: [{ event: 'REQUEST_REMOVE', scope: 'internal', payloadSchema: [{ name: 'id', type: 'string' }] }],
  };
  const removeIcon = { name: 'RemoveIcon', stateMachine: { transitions: [] } };
  const removeAlert = { name: 'RemoveAlert', stateMachine: { transitions: [] } };

  it('flags the std-ecommerce shape: modal container omitted from the page decl its children mount on', () => {
    const result = lintWiring(
      schemaWith({
        name: 'CartOrbital',
        traits: [removeConfirm, browse, removeIcon, removeAlert],
        pages: [
          {
            name: 'CartPage',
            path: '/cart',
            traits: [{ ref: 'Browse' }, { ref: 'RemoveIcon' }, { ref: 'RemoveAlert' }],
          },
        ],
      }),
    );
    expect(result.errors).toBe(1);
    const finding = result.findings[0];
    expect(finding?.check).toBe('client-unbound-state-machine');
    expect(finding?.trait).toBe('RemoveConfirm');
    expect(finding?.suggestion).toContain('/cart');
  });

  it('is clean once the container is page-mounted (the applied fix)', () => {
    const result = lintWiring(
      schemaWith({
        name: 'CartOrbital',
        traits: [removeConfirm, browse, removeIcon, removeAlert],
        pages: [
          {
            name: 'CartPage',
            path: '/cart',
            traits: [{ ref: 'Browse' }, { ref: 'RemoveConfirm' }, { ref: 'RemoveIcon' }, { ref: 'RemoveAlert' }],
          },
        ],
      }),
    );
    expect(result.findings).toEqual([]);
  });

  it('credits binding through the transitive @trait embed closure, config and state machine alike', () => {
    const composer = {
      name: 'Composer',
      stateMachine: {
        transitions: [
          { from: 'idle', event: 'INIT', to: 'idle', effects: [['render-ui', 'main', { children: ['@trait.Middle'] }]] },
        ],
      },
    };
    const middle = { name: 'Middle', stateMachine: { transitions: [] }, config: { body: '@trait.RemoveConfirm' } };
    const result = lintWiring(
      schemaWith({
        name: 'CartOrbital',
        traits: [composer, middle, removeConfirm, browse],
        pages: [{ name: 'CartPage', path: '/cart', traits: [{ ref: 'Composer' }, { ref: 'Browse' }] }],
      }),
    );
    expect(result.findings).toEqual([]);
  });

  it('skips orbitals with no pages (registry atoms lint at their own page)', () => {
    const result = lintWiring(schemaWith({ name: 'AtomOrbital', traits: [removeConfirm], pages: [] }));
    expect(result.findings).toEqual([]);
  });
});

describe('lintWiring — listens-source-never-emits', () => {
  it('flags the std-cicd shape: route names a source that never produces the event', () => {
    const result = lintWiring(
      schemaWith({
        name: 'BuildOrbital',
        traits: [
          {
            name: 'BuildCatalog',
            stateMachine: { transitions: [{ from: 'idle', event: 'INIT', to: 'idle', effects: [] }] },
          },
          {
            name: 'BuildButtonCreate',
            stateMachine: { transitions: [] },
            config: { action: 'CREATE' },
          },
          {
            name: 'BuildCreate',
            stateMachine: { transitions: [{ from: 'closed', event: 'CREATE', to: 'open', effects: [] }] },
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
      }),
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
      schemaWith({
        name: 'TaskListOrbital',
        traits: [
          { name: 'ListCreate', ref: 'Modal.traits.ModalRecordModal' },
          {
            name: 'ListPersistor',
            stateMachine: { transitions: [{ from: 'ready', event: 'DO_CREATE', to: 'ready', effects: [] }] },
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
      }),
    );
    expect(result.findings.filter((f) => f.check === 'listens-source-never-emits')).toEqual([]);
  });

  it('a source that exists NOWHERE (neither inline nor declared ref) still flags missing-source', () => {
    const result = lintWiring(
      schemaWith({
        name: 'TaskListOrbital',
        traits: [
          {
            name: 'ListPersistor',
            stateMachine: { transitions: [{ from: 'ready', event: 'DO_CREATE', to: 'ready', effects: [] }] },
            listens: [{ event: 'SAVE', triggers: 'DO_CREATE', source: { kind: 'trait', trait: 'GhostTrait' } }],
          },
        ],
        pages: [{ name: 'ListPage', path: '/list', traits: [{ ref: 'ListPersistor' }] }],
      }),
    );
    const missing = result.findings.filter((f) => f.check === 'listens-source-never-emits');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.message).toContain('GhostTrait does not exist');
  });

  it('credits every production form: emits contract, effect emit option, explicit emit effect, action affordance, itemActions', () => {
    const result = lintWiring(
      schemaWith({
        name: 'MixOrbital',
        traits: [
          {
            name: 'Grid',
            stateMachine: {
              transitions: [
                {
                  from: 'idle',
                  event: 'INIT',
                  to: 'idle',
                  effects: [
                    ['fetch', 'Row', { emit: { success: 'RowsLoaded' } }],
                    ['emit', 'PING', { at: '@entity.id' }],
                    ['render-ui', 'main', { children: [{ type: 'button', action: 'OPEN' }] }],
                  ],
                },
              ],
            },
            emits: [{ event: 'SELECTED', scope: 'internal' }],
            config: { itemActions: [{ event: 'EDIT', label: 'Edit' }] },
          },
          {
            name: 'Sink',
            stateMachine: {
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
      }),
    );
    expect(result.findings).toEqual([]);
  });

  it('flags a route whose source trait does not exist', () => {
    const result = lintWiring(
      schemaWith({
        name: 'GhostOrbital',
        traits: [
          {
            name: 'Sink',
            stateMachine: { transitions: [{ from: 'a', event: 'X', to: 'a', effects: [] }] },
            listens: [{ event: 'X', triggers: 'X', source: { kind: 'trait', trait: 'Ghost' } }],
          },
        ],
        pages: [{ name: 'P', path: '/p', traits: [{ ref: 'Sink' }] }],
      }),
    );
    expect(result.errors).toBe(1);
    expect(result.findings[0]?.message).toContain('does not exist');
  });
});

describe('lintWiring — payload-starved-route', () => {
  const modal = {
    name: 'CourseEdit',
    stateMachine: { transitions: [{ from: 'closed', event: 'EDIT_COURSE', to: 'open', effects: [] }] },
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
  };

  it('flags the std-lms shape: header button emits the event with no payload while the contract requires id', () => {
    const result = lintWiring(
      schemaWith({
        name: 'CourseOrbital',
        traits: [
          modal,
          {
            name: 'HeaderButton',
            stateMachine: { transitions: [] },
            emits: [{ event: 'EDIT_COURSE', scope: 'internal' }],
          },
        ],
        pages: [{ name: 'P', path: '/courses', traits: [{ ref: 'CourseEdit' }, { ref: 'HeaderButton' }] }],
      }),
    );
    expect(result.errors).toBe(1);
    const finding = result.findings[0];
    expect(finding?.check).toBe('payload-starved-route');
    expect(finding?.message).toContain('{id}');
  });

  it('is satisfied by the itemActions native {id, row} payload (the applied std-lms fix)', () => {
    const result = lintWiring(
      schemaWith({
        name: 'CourseOrbital',
        traits: [
          { ...modal, listens: [{ event: 'EDIT_COURSE', triggers: 'EDIT_COURSE', source: { kind: 'trait', trait: 'Gallery' } }] },
          {
            name: 'Gallery',
            stateMachine: { transitions: [] },
            config: { itemActions: [{ event: 'EDIT_COURSE', label: 'Edit' }] },
          },
        ],
        pages: [{ name: 'P', path: '/courses', traits: [{ ref: 'CourseEdit' }, { ref: 'Gallery' }] }],
      }),
    );
    expect(result.findings).toEqual([]);
  });

  it('credits payloadMapping renames when deciding starvation', () => {
    const result = lintWiring(
      schemaWith({
        name: 'SearchOrbital',
        traits: [
          {
            name: 'Search',
            stateMachine: { transitions: [{ from: 'idle', event: 'SEARCH', to: 'searching', effects: [] }] },
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
            stateMachine: { transitions: [] },
            emits: [{ event: 'TOP_SEARCH', scope: 'internal', payloadSchema: [{ name: 'value', type: 'string' }] }],
          },
        ],
        pages: [{ name: 'P', path: '/p', traits: [{ ref: 'Search' }, { ref: 'Layout' }] }],
      }),
    );
    expect(result.findings).toEqual([]);
  });

  // `with { k: <expr> }` values are full s-expressions, not just renames. A
  // value supplies its target when every `@payload.<field>` it reads is itself
  // supplied by the emitter — the escalating-ladder shape, where each rung
  // projects the next rung's inputs out of a carried request object.
  const ladderSchema = (emitterPayload: { name: string; type: string }[]) =>
    schemaWith({
      name: 'LadderOrbital',
      traits: [
        {
          name: 'LookupRung',
          stateMachine: { transitions: [{ from: 'idle', event: 'LOOKUP', to: 'checked', effects: [] }] },
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
          stateMachine: { transitions: [] },
          emits: [{ event: 'EXACT_UNMATCHED', scope: 'internal', payloadSchema: emitterPayload }],
        },
      ],
      pages: [{ name: 'P', path: '/p', traits: [{ ref: 'LookupRung' }, { ref: 'ExactRung' }] }],
    });

  it('credits an expression mapping whose @payload reads are all supplied', () => {
    const result = lintWiring(
      ladderSchema([
        { name: 'candidate', type: 'string' },
        { name: 'request', type: 'object' },
      ]),
    );
    expect(result.findings).toEqual([]);
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
  const mainRender = (pattern: unknown) => ['render-ui', 'main', pattern];
  const contentBody = { type: 'stack', children: [{ type: 'typography', content: 'rows' }] };

  const shell = {
    name: 'AppLayout',
    config: { contentTrait: '@trait.Search' },
    stateMachine: {
      transitions: [
        { from: 'composing', event: 'INIT', to: 'composing', effects: [mainRender({ type: 'box', children: ['@trait.Search'] })] },
      ],
    },
  };
  const search = {
    name: 'Search',
    config: { idleContent: '@trait.Catalog' },
    stateMachine: {
      transitions: [{ from: 'idle', event: 'INIT', to: 'idle', effects: [mainRender({ type: 'box', children: ['@trait.Catalog'] })] }],
    },
  };
  const catalog = {
    name: 'Catalog',
    stateMachine: {
      transitions: [{ from: 'browsing', event: 'INIT', to: 'browsing', effects: [mainRender(contentBody)] }],
    },
  };
  const page = (extraRefs: string[]) => ({
    name: 'P',
    path: '/p',
    traits: [{ ref: 'AppLayout' }, { ref: 'Search' }, { ref: 'Catalog' }, ...extraRefs.map((ref) => ({ ref }))],
  });

  it('is clean on the composed convention (shell + channel-claimed content body)', () => {
    const result = lintWiring(
      schemaWith({ name: 'O', traits: [shell, search, catalog], pages: [page([])] }),
    );
    expect(result.findings).toEqual([]);
  });

  it('warns on an unclaimed second content body (the std-accounting /entries shape)', () => {
    const secondBrowse = {
      name: 'SecondBrowse',
      stateMachine: {
        transitions: [{ from: 'browsing', event: 'INIT', to: 'browsing', effects: [mainRender({ type: 'data-grid' })] }],
      },
    };
    const result = lintWiring(
      schemaWith({ name: 'O', traits: [shell, search, catalog, secondBrowse], pages: [page(['SecondBrowse'])] }),
    );
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(1);
    expect(result.findings[0]?.check).toBe('unclaimed-main-writer');
    expect(result.findings[0]?.trait).toBe('SecondBrowse');
  });

  it('is clean once the second body is claimed through the channel (the applied fix)', () => {
    const claimedBrowse = {
      name: 'SecondBrowse',
      stateMachine: {
        transitions: [{ from: 'browsing', event: 'INIT', to: 'browsing', effects: [mainRender({ type: 'data-grid' })] }],
      },
    };
    const fixedSearch = { ...search, config: { idleContent: '@trait.SecondBrowse' } };
    const result = lintWiring(
      schemaWith({
        name: 'O',
        traits: [shell, fixedSearch, claimedBrowse],
        pages: [{ name: 'P', path: '/p', traits: [{ ref: 'AppLayout' }, { ref: 'Search' }, { ref: 'SecondBrowse' }] }],
      }),
    );
    expect(result.findings).toEqual([]);
  });

  it('ignores modal-cleanup placeholder main-writes (childless box)', () => {
    const modal = {
      name: 'Edit',
      stateMachine: {
        transitions: [
          { from: 'open', event: 'CLOSE', to: 'closed', effects: [mainRender({ type: 'box' }), ['render-ui', 'modal', null]] },
        ],
      },
    };
    const result = lintWiring(
      schemaWith({ name: 'O', traits: [shell, search, catalog, modal], pages: [page(['Edit'])] }),
    );
    expect(result.findings).toEqual([]);
  });

  it('ignores page-mounted atomic chrome', () => {
    const chrome = {
      name: 'InlineIconRender1',
      stateMachine: {
        transitions: [{ from: 'idle', event: 'INIT', to: 'idle', effects: [mainRender({ type: 'icon' })] }],
      },
    };
    const result = lintWiring(
      schemaWith({ name: 'O', traits: [shell, search, catalog, chrome], pages: [page(['InlineIconRender1'])] }),
    );
    expect(result.findings).toEqual([]);
  });

  it('ignores a page-mounted feature when no channel body exists (shell+feature convention)', () => {
    const bareShell = {
      name: 'AppLayout',
      stateMachine: {
        transitions: [{ from: 'composing', event: 'INIT', to: 'composing', effects: [mainRender({ type: 'box', children: [] })] }],
      },
    };
    const feature = {
      name: 'Upload',
      stateMachine: {
        transitions: [{ from: 'idle', event: 'INIT', to: 'idle', effects: [mainRender(contentBody)] }],
      },
    };
    const result = lintWiring(
      schemaWith({
        name: 'O',
        traits: [bareShell, feature],
        pages: [{ name: 'P', path: '/p', traits: [{ ref: 'AppLayout' }, { ref: 'Upload' }] }],
      }),
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
    const shellWithChannel = {
      name: 'ShellWithChannel',
      config: { contentTrait: '@trait.ChannelBody' },
      stateMachine: {
        transitions: [
          { from: 'composing', event: 'INIT', to: 'composing', effects: [mainRender({ type: 'box', children: ['@trait.ChannelBody'] })] },
        ],
      },
    };
    const channelBody = {
      name: 'ChannelBody',
      stateMachine: {
        transitions: [{ from: 'browsing', event: 'INIT', to: 'browsing', effects: [mainRender(contentBody)] }],
      },
    };
    // StrayFeature shares no designation or containment edge with either of
    // the above — a genuinely independent second body stacked on the page.
    const strayFeature = {
      name: 'StrayFeature',
      stateMachine: {
        transitions: [{ from: 'idle', event: 'INIT', to: 'idle', effects: [mainRender(contentBody)] }],
      },
    };
    const result = lintWiring(
      schemaWith({
        name: 'O',
        traits: [shellWithChannel, channelBody, strayFeature],
        pages: [
          {
            name: 'P',
            path: '/p',
            traits: [{ ref: 'ShellWithChannel' }, { ref: 'ChannelBody' }, { ref: 'StrayFeature' }],
          },
        ],
      }),
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
    const outerComposer = {
      name: 'OuterComposer',
      stateMachine: {
        transitions: [
          { from: 'composing', event: 'INIT', to: 'composing', effects: [mainRender({ type: 'box', children: ['@trait.MiddleWrapper'] })] },
        ],
      },
    };
    // MiddleWrapper designates InnerBody through config — the synthetic
    // sibling's own internal channel link (std-browse's DataGrid1 ->
    // DenseTableView -> MasterListView chain, flattened here to one hop).
    const middleWrapper = { name: 'MiddleWrapper', config: { body: '@trait.InnerBody' } };
    const innerBody = {
      name: 'InnerBody',
      stateMachine: {
        transitions: [{ from: 'browsing', event: 'INIT', to: 'browsing', effects: [mainRender(contentBody)] }],
      },
    };
    const result = lintWiring(
      schemaWith({
        name: 'O',
        traits: [outerComposer, middleWrapper, innerBody],
        pages: [
          {
            name: 'P',
            path: '/p',
            traits: [{ ref: 'OuterComposer' }, { ref: 'MiddleWrapper' }, { ref: 'InnerBody' }],
          },
        ],
      }),
    );
    expect(result.findings).toEqual([]);
  });
});

describe('lintWiring — steady-state-no-init-reentry', () => {
  const mainRender = (pattern: unknown) => ['render-ui', 'main', pattern];
  const rowsBody = { type: 'stack', children: [{ type: 'data-grid' }] };
  const spinner = { type: 'loading-state', title: 'Loading…' };
  const fetchRows = ['fetch', 'Board', { emit: { success: 'RowsLoaded', failure: 'RowsFailed' } }];

  /** The std-board shape: `loading` fetches, `browsing` shows the rows. */
  const browseTrait = (browsingTransitions: unknown[]) => ({
    name: 'Board',
    stateMachine: {
      states: [{ name: 'loading', isInitial: true }, { name: 'browsing' }],
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
      schemaWith({ name: 'O', traits: [browseTrait([{ from: 'browsing', event: 'OPEN_CARD', to: 'browsing', effects: [] }])], pages: [page] }),
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
      schemaWith({
        name: 'O',
        traits: [browseTrait([{ from: 'browsing', event: 'INIT', to: 'loading', effects: [fetchRows, mainRender(spinner)] }])],
        pages: [page],
      }),
    );
    expect(result.findings.filter((f) => f.check === 'steady-state-no-init-reentry')).toEqual([]);
  });

  it('accepts a wildcard INIT as covering every steady state', () => {
    const result = lintWiring(
      schemaWith({
        name: 'O',
        traits: [browseTrait([{ from: '*', event: 'INIT', to: 'loading', effects: [fetchRows] }])],
        pages: [page],
      }),
    );
    expect(result.findings.filter((f) => f.check === 'steady-state-no-init-reentry')).toEqual([]);
  });

  it('ignores a steady state that paints no content body (nothing visible to strand)', () => {
    const logger = {
      name: 'Board',
      stateMachine: {
        states: [{ name: 'loading', isInitial: true }, { name: 'browsing' }],
        transitions: [
          { from: 'loading', event: 'INIT', to: 'loading', effects: [fetchRows] },
          { from: 'loading', event: 'RowsLoaded', to: 'browsing', effects: [['set', '@entity.rows', '?data']] },
        ],
      },
    };
    const result = lintWiring(schemaWith({ name: 'O', traits: [logger], pages: [page] }));
    expect(result.findings.filter((f) => f.check === 'steady-state-no-init-reentry')).toEqual([]);
  });

  it('ignores a trait the client never binds (no page decl, no embed)', () => {
    const result = lintWiring(
      schemaWith({
        name: 'O',
        traits: [browseTrait([]), { name: 'Shell', stateMachine: { transitions: [{ from: 'idle', event: 'INIT', to: 'idle', effects: [] }] } }],
        pages: [{ name: 'P', path: '/board', traits: [{ ref: 'Shell' }] }],
      }),
    );
    expect(result.findings.filter((f) => f.check === 'steady-state-no-init-reentry')).toEqual([]);
  });
});

describe('lintWiring — unscoped-owned-entity', () => {
  /**
   * An app whose `Ticket.assignee` points at the `[identity]` `Person`.
   * `readPolicy` is the `@read` directive; absent means ALLOW-ALL.
   */
  function appWithOwnerColumn(readPolicy?: unknown): OrbitalSchema {
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
    } as unknown as OrbitalSchema;
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
    const schema = {
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
    } as unknown as OrbitalSchema;
    expect(unscoped(schema)).toHaveLength(0);
  });

  it('does not guess from a field NAME — a bare string owner is invisible', () => {
    // Name matching would scope the wrong column. The campaign retypes these to
    // a real reference, and the lint lights up only then.
    const schema = appWithOwnerColumn();
    const ticket = (schema.orbitals[0] as unknown as { entity: { fields: unknown[] } }).entity;
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
    } as unknown as OrbitalSchema;
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
  const painted = (slot: string) => ['render-ui', slot, { type: 'stack', children: [] }];

  it('flags a state-changing arm with no effects, on a state this trait paints', () => {
    const result = lintWiring(
      schemaWith({
        name: 'PreviewOrbital',
        traits: [
          {
            name: 'SchemaPreview',
            stateMachine: {
              transitions: [
                { from: 'loading', event: 'PREVIEW_ERROR', to: 'error', effects: [painted('main')] },
                { from: 'error', event: 'START_PREVIEW', to: 'loading', effects: [] },
              ],
            },
          },
        ],
        pages: [{ name: 'PreviewPage', path: '/preview', traits: [{ ref: 'SchemaPreview' }] }],
      }),
    );
    const found = result.findings.filter((f) => f.check === 'dead-bodiless-action');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('error -> loading');
  });

  it('does not flag a lifecycle trait that paints nothing, nor a bodiless self-transition', () => {
    const result = lintWiring(
      schemaWith({
        name: 'PreviewOrbital',
        traits: [
          {
            name: 'ProjectErasure',
            stateMachine: {
              transitions: [
                { from: 'execScanning', event: 'ExecScanLoaded', to: 'idle', effects: [] },
                { from: 'idle', event: 'STOP', to: 'idle', effects: [] },
              ],
            },
          },
        ],
        pages: [{ name: 'P', path: '/p', traits: [{ ref: 'ProjectErasure' }] }],
      }),
    );
    expect(result.findings.filter((f) => f.check === 'dead-bodiless-action')).toHaveLength(0);
  });
});

describe('lintWiring — dead-lifecycle-emit', () => {
  it('flags (emit INIT) used as a repaint', () => {
    const result = lintWiring(
      schemaWith({
        name: 'PreviewOrbital',
        traits: [
          {
            name: 'SchemaPreview',
            stateMachine: {
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
      }),
    );
    const found = result.findings.filter((f) => f.check === 'dead-lifecycle-emit');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("emits 'INIT'");
  });

  it('leaves a normal (emit X) alone', () => {
    const result = lintWiring(
      schemaWith({
        name: 'PreviewOrbital',
        traits: [
          {
            name: 'SchemaPreview',
            stateMachine: {
              transitions: [
                { from: 'previewing', event: 'STOP_PREVIEW', to: 'idle', effects: [['emit', 'PREVIEW_STOPPED']] },
              ],
            },
          },
        ],
        pages: [{ name: 'P', path: '/p', traits: [{ ref: 'SchemaPreview' }] }],
      }),
    );
    expect(result.findings.filter((f) => f.check === 'dead-lifecycle-emit')).toHaveLength(0);
  });
});

describe('lintWiring — dead-lifecycle-action reads registry-declared event props', () => {
  const pageFor = (trait: string) => ({ name: 'P', path: '/p', traits: [{ ref: trait }] });
  const traitRendering = (name: string, node: Record<string, unknown>) => ({
    name,
    stateMachine: { transitions: [{ from: 'idle', event: 'INIT', to: 'idle', effects: [['render-ui', 'main', node]] }] },
  });
  const lifecycleFindings = (node: Record<string, unknown>) =>
    lintWiring(
      schemaWith({ name: 'O', traits: [traitRendering('T', node)], pages: [pageFor('T')] }),
    ).findings.filter((f) => f.check === 'dead-lifecycle-action');

  it('flags `action` — the shape the pre-widening rule already caught', () => {
    expect(lifecycleFindings({ type: 'button', action: 'INIT' })).toHaveLength(1);
  });

  it("flags error-state's `retryEvent`/`onRetry` (the std-cms upload-failure retry)", () => {
    expect(lifecycleFindings({ type: 'error-state', retryEvent: 'INIT', onRetry: 'INIT' })).toHaveLength(1);
  });

  it("flags form-section's `cancelEvent` (the std-form-advanced dead Cancel)", () => {
    expect(lifecycleFindings({ type: 'form-section', cancelEvent: 'INIT' })).toHaveLength(1);
  });

  it("flags empty-state's `actionEvent` (the std-inventory 'Back to inventory')", () => {
    expect(lifecycleFindings({ type: 'empty-state', actionEvent: 'LOAD' })).toHaveLength(1);
  });

  it('resolves the prop against the node type — an undeclared prop of the same name is not an affordance', () => {
    expect(lifecycleFindings({ type: 'typography', retryEvent: 'INIT' })).toHaveLength(0);
  });

  it('leaves a first-class event on a declared prop alone', () => {
    expect(lifecycleFindings({ type: 'error-state', retryEvent: 'RETRY', onRetry: 'RETRY' })).toHaveLength(0);
  });

  it('reads an event-list descriptor array through its declared eventField', () => {
    expect(
      lifecycleFindings({ type: 'data-grid', itemActions: [{ event: 'INIT', label: 'Refresh' }] }),
    ).toHaveLength(1);
  });
});

describe('lintWiring — viewer-stranded credits value-input controls', () => {
  const mainRender = (pattern: unknown) => ['render-ui', 'main', pattern];
  const page = { name: 'P', path: '/lab', traits: [{ ref: 'Lab' }] };

  const labWith = (repaintBody: unknown) => ({
    name: 'Lab',
    stateMachine: {
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
      schemaWith({
        name: 'O',
        traits: [labWith({ type: 'stack', children: [{ type: 'range-slider', value: 10, onChange: 'SET_X' }] })],
        pages: [page],
      }),
    );
    expect(result.findings.filter((f) => f.check === 'viewer-stranded')).toEqual([]);
  });

  it('POSITIVE CONTROL: a labelless button-only repaint still strands', () => {
    const result = lintWiring(
      schemaWith({
        name: 'O',
        traits: [labWith({ type: 'stack', children: [{ type: 'button', action: 'SET_X' }] })],
        pages: [page],
      }),
    );
    const stranded = result.findings.filter((f) => f.check === 'viewer-stranded');
    expect(stranded).toHaveLength(1);
    expect(stranded[0].trait).toBe('Lab');
  });

  it('an S-expression label the render evaluator resolves to text is a way on (the earth-lab shape)', () => {
    const result = lintWiring(
      schemaWith({
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
      }),
    );
    expect(result.findings.filter((f) => f.check === 'viewer-stranded')).toEqual([]);
  });

  it('POSITIVE CONTROL: an unresolved string-sigil label still strands', () => {
    const result = lintWiring(
      schemaWith({
        name: 'O',
        traits: [labWith({ type: 'stack', children: [{ type: 'button', action: 'SET_X', label: '@config.actionLabel' }] })],
        pages: [page],
      }),
    );
    const stranded = result.findings.filter((f) => f.check === 'viewer-stranded');
    expect(stranded).toHaveLength(1);
    expect(stranded[0].trait).toBe('Lab');
  });
});
