import { describe, it, expect } from 'vitest';
import type { AnyPatternConfig, Effect, Entity, Orbital, OrbitalSchema, PageRef, SExpr, Trait, TraitRef, Transition } from '@almadar/core';
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
