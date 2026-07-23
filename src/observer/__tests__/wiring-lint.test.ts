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
                payloadMapping: { value: 'searchTerm' },
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
});
