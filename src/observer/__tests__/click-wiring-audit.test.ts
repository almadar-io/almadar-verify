import { describe, it, expect } from 'vitest';
import type { Effect, OrbitalSchema, StateMachine, Trait, Transition } from '@almadar/core';
import { OrbitalIdSchema, TraitIdSchema, EventIdSchema } from '@almadar/core';
import { auditListens } from '../click-wiring-audit.js';

/** A complete `StateMachine` from just its transitions — states and events are
 *  derivable, and spelling them out per fixture obscures what each test is about. */
function machine(transitions: Transition[]): StateMachine {
  const states = [...new Set(transitions.flatMap((t) => [t.from, t.to].flat()))];
  const events = [...new Set(transitions.map((t) => t.event))];
  return {
    states: states.map((name, i) => ({ name, isInitial: i === 0 })),
    events: events.map((key) => ({ key, name: key })),
    transitions,
  };
}

/** A trait with only the fields this audit reads; `scope` is the one other required field. */
function trait(fields: Omit<Trait, 'scope'>): Trait {
  return { scope: 'collection', ...fields };
}

/** One orbital holding `traits`; the audit never reads the entity or pages. */
function schema(traits: Trait[]): OrbitalSchema {
  return {
    name: 'AuditFixture',
    orbitals: [{ name: 'Fixture', entity: 'Note', traits, pages: [] }],
  };
}

describe('auditListens', () => {
  it('wires a declared emit picked up by a listens block', () => {
    const orbital = schema([
      trait({
        name: 'Browse',
        stateMachine: machine([{ from: 'browsing', event: 'INIT', to: 'browsing' }]),
        emits: [{ event: 'REQUEST_DELETE', scope: 'internal' }],
      }),
      trait({
        name: 'Delete',
        stateMachine: machine([{ from: 'idle', event: 'DELETE', to: 'confirming' }]),
        listens: [
          { event: 'REQUEST_DELETE', triggers: 'DELETE', source: { kind: 'trait', trait: 'Browse' } },
        ],
      }),
    ]);

    const result = auditListens(orbital);
    expect(result.missing).toEqual([]);
    expect(result.bodiless).toEqual([]);
    expect(result.emitters).toEqual([
      { orbital: 'Fixture', trait: 'Browse', event: 'REQUEST_DELETE', wired: true, via: 'listens' },
    ]);
  });

  it('wires a declared emit the emitting trait handles itself (self-transition)', () => {
    const pausedRender: Effect = ['render-ui', 'main', { type: 'typography', content: 'paused' }];
    const orbital = schema([
      trait({
        name: 'Timer',
        stateMachine: machine([
          { from: 'running', event: 'PAUSE', to: 'paused', effects: [pausedRender] },
        ]),
        emits: [{ event: 'PAUSE', scope: 'internal' }],
      }),
    ]);

    const result = auditListens(orbital);
    expect(result.missing).toEqual([]);
    expect(result.bodiless).toEqual([]);
    expect(result.emitters).toEqual([
      { orbital: 'Fixture', trait: 'Timer', event: 'PAUSE', wired: true, via: 'self-transition' },
    ]);
  });

  it('flags a declared emit with no self-transition and no listener, suggesting the listens fix', () => {
    const orbital = schema([
      trait({
        name: 'Browse',
        stateMachine: machine([{ from: 'browsing', event: 'INIT', to: 'browsing' }]),
        emits: [{ event: 'ORPHAN_EVENT', scope: 'internal' }],
      }),
    ]);

    const result = auditListens(orbital);
    expect(result.emitters).toEqual([
      { orbital: 'Fixture', trait: 'Browse', event: 'ORPHAN_EVENT', wired: false, via: null },
    ]);
    expect(result.bodiless).toEqual([]);
    expect(result.missing).toEqual([
      {
        orbital: 'Fixture',
        trait: 'Browse',
        event: 'ORPHAN_EVENT',
        suggestion: 'listens { Browse.ORPHAN_EVENT -> ORPHAN_EVENT }',
      },
    ]);
  });

  // T-AUDIT-LISTENS-INLINE-CHILD-FALSE-POSITIVE: an `Inline*Render` child
  // emits under its embedder's scope, so the HOST's self-transition is the
  // child's wiring. The audit used to report every such button unwired and
  // suggest a `listens` line that must never be applied.
  it('wires an embedded child whose host carries the transition', () => {
    const renderEmbed: Effect = ['render-ui', 'modal', '@trait.InlineButtonRender5'];
    const orbital = schema([
      trait({
        name: 'NoteOverlayPanel',
        stateMachine: machine([
          { from: 'idle', event: 'CLOSE_OVERLAY', to: 'idle', effects: [renderEmbed] },
        ]),
      }),
      trait({
        name: 'InlineButtonRender5',
        config: { action: { type: 'string', default: 'CLOSE_OVERLAY' } },
        emits: [{ event: 'CLOSE_OVERLAY', scope: 'internal' }],
      }),
    ]);

    const result = auditListens(orbital);
    expect(result.missing).toEqual([]);
    expect(result.bodiless).toEqual([]);
    expect(result.emitters).toEqual([
      {
        orbital: 'Fixture',
        trait: 'InlineButtonRender5',
        event: 'CLOSE_OVERLAY',
        wired: true,
        via: 'host-transition',
        host: 'NoteOverlayPanel',
      },
    ]);
  });

  it('still flags an embedded child no host anywhere up the chain handles', () => {
    const renderEmbed: Effect = ['render-ui', 'main', '@trait.InlineButtonRender1'];
    const orbital = schema([
      trait({
        name: 'Panel',
        stateMachine: machine([{ from: 'idle', event: 'INIT', to: 'idle', effects: [renderEmbed] }]),
      }),
      trait({
        name: 'InlineButtonRender1',
        config: { action: { type: 'string', default: 'ORPHAN_EVENT' } },
        emits: [{ event: 'ORPHAN_EVENT', scope: 'internal' }],
      }),
    ]);

    const result = auditListens(orbital);
    expect(result.emitters).toEqual([
      { orbital: 'Fixture', trait: 'InlineButtonRender1', event: 'ORPHAN_EVENT', wired: false, via: null },
    ]);
    expect(result.bodiless).toEqual([]);
    expect(result.missing).toHaveLength(1);
  });

  it('excludes fetch/persist success|failure auto-emits (never button-ish)', () => {
    const fetchEffect: Effect = [
      'fetch',
      'Node',
      { emit: { success: 'NodeLoaded', failure: 'NodeLoadFailed' } },
    ];
    const orbital = schema([
      trait({
        name: 'Circuit',
        stateMachine: machine([
          { from: 'closed', event: 'INIT', to: 'closed', effects: [fetchEffect] },
        ]),
        emits: [
          { event: 'NodeLoaded', scope: 'internal' },
          { event: 'NodeLoadFailed', scope: 'internal' },
        ],
      }),
    ]);

    const result = auditListens(orbital);
    expect(result.emitters).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.bodiless).toEqual([]);
  });

  // V-AUDIT-LISTENS-COUNTS-A-BODILESS-SELF-TRANSITION-AS-WIRED: the arm exists,
  // so the emit is routed — but it carries no effects, so the button paints
  // nothing. `orb validate`'s ORB_CIRCUIT_DEAD_BODILESS_ACTION deliberately skips from === to
  // arms, which is why this shape has no other home. Shape taken from
  // std-app-layout.lolo:52 (`NOTIFY_CLICK -> composing`), renamed onto by
  // std-fitness-studio.
  it("reports a routed emit whose only arm is effect-free as 'bodiless', not wired", () => {
    const composingRender: Effect = ['render-ui', 'main', { type: 'stack' }];
    const orbital = schema([
      trait({
        name: 'AppLayout',
        stateMachine: machine([
          { from: 'composing', event: 'INIT', to: 'composing', effects: [composingRender] },
          { from: 'composing', event: 'NOTIFY_CLICK', to: 'composing' },
        ]),
        emits: [{ event: 'NOTIFY_CLICK', scope: 'internal' }],
      }),
    ]);

    const result = auditListens(orbital);
    expect(result.missing).toEqual([]);
    expect(result.emitters).toEqual([
      { orbital: 'Fixture', trait: 'AppLayout', event: 'NOTIFY_CLICK', wired: 'bodiless', via: 'self-transition' },
    ]);
    expect(result.bodiless).toHaveLength(1);
    expect(result.bodiless[0]).toMatchObject({
      trait: 'AppLayout',
      event: 'NOTIFY_CLICK',
      handler: 'AppLayout',
    });
    expect(result.bodiless[0]?.suggestion).not.toContain('listens {');
  });

  // One effect-carrying arm anywhere on the event is enough: the affordance is
  // live from at least one state, so calling the emit dead would be a false
  // positive.
  it('stays wired when one arm on the event carries effects and a sibling arm does not', () => {
    const render: Effect = ['render-ui', 'main', { type: 'stack' }];
    const orbital = schema([
      trait({
        name: 'Panel',
        stateMachine: machine([
          { from: 'idle', event: 'OPEN', to: 'open', effects: [render] },
          { from: 'open', event: 'OPEN', to: 'open' },
        ]),
        emits: [{ event: 'OPEN', scope: 'internal' }],
      }),
    ]);

    const result = auditListens(orbital);
    expect(result.bodiless).toEqual([]);
    expect(result.emitters).toEqual([
      { orbital: 'Fixture', trait: 'Panel', event: 'OPEN', wired: true, via: 'self-transition' },
    ]);
  });

  // An effectful host outranks a nearer bodiless one — the real route IS the
  // wiring, and reporting the dead host instead would invent a defect.
  it('prefers an effect-carrying host over a bodiless one up the embed chain', () => {
    const outerRender: Effect = ['render-ui', 'main', '@trait.Middle'];
    const middleRender: Effect = ['render-ui', 'main', '@trait.InlineButtonRender9'];
    const orbital = schema([
      trait({
        name: 'Outer',
        stateMachine: machine([
          { from: 'idle', event: 'INIT', to: 'idle', effects: [outerRender] },
          { from: 'idle', event: 'ACT', to: 'idle', effects: [outerRender] },
        ]),
      }),
      trait({
        name: 'Middle',
        stateMachine: machine([
          { from: 'idle', event: 'INIT', to: 'idle', effects: [middleRender] },
          { from: 'idle', event: 'ACT', to: 'idle' },
        ]),
      }),
      trait({
        name: 'InlineButtonRender9',
        config: { action: { type: 'string', default: 'ACT' } },
        emits: [{ event: 'ACT', scope: 'internal' }],
      }),
    ]);

    const result = auditListens(orbital);
    expect(result.missing).toEqual([]);
    expect(result.bodiless).toEqual([]);
    expect(result.emitters).toEqual([
      {
        orbital: 'Fixture',
        trait: 'InlineButtonRender9',
        event: 'ACT',
        wired: true,
        via: 'host-transition',
        host: 'Outer',
      },
    ]);
  });

  // RV item 27 (New runtime observers ... audit_listens fix): an emit
  // declared in the contract but backed ONLY by an itemActions/
  // browseItemActions config array the resolved call site narrowed away
  // can never fire at all — reporting `missing` ("add a listens line")
  // would invent a defect nothing could ever deliver.
  it('excludes a config-gated itemActions event the resolved call site narrowed away from missing', () => {
    const browse = trait({
      name: 'Browse',
      emits: [{ event: 'EDIT_ROW', scope: 'internal' }],
      stateMachine: machine([{ from: 'browsing', event: 'INIT', to: 'browsing' }]),
      config: { itemActions: { type: 'array', default: [{ event: 'VIEW', label: 'View' }] } },
    });

    const result = auditListens(schema([browse]));
    expect(result.missing).toEqual([]);
    expect(result.emitters).toEqual([]);
  });

  it('still reports missing once the itemActions config DOES include the event but nothing listens', () => {
    const browse = trait({
      name: 'Browse',
      emits: [{ event: 'EDIT_ROW', scope: 'internal' }],
      stateMachine: machine([{ from: 'browsing', event: 'INIT', to: 'browsing' }]),
      config: { itemActions: { type: 'array', default: [{ event: 'VIEW', label: 'View' }, { event: 'EDIT_ROW', label: 'Edit' }] } },
    });

    const result = auditListens(schema([browse]));
    expect(result.missing).toEqual([{ orbital: 'Fixture', trait: 'Browse', event: 'EDIT_ROW', suggestion: 'listens { Browse.EDIT_ROW -> EDIT_ROW }' }]);
  });
});

describe('declared listener source identity', () => {
  const emitter = trait({ name: 'Cart', emits: [{ event: 'CHECKOUT_STARTED', scope: 'external' }] });
  const handler = (source?: NonNullable<Trait['listens']>[number]['source']) => trait({ name: 'Checkout', listens: [{ event: 'CHECKOUT_STARTED', triggers: 'START', ...(source ? { source } : {}) }] });
  const app = (listener: Trait): OrbitalSchema => ({ name: 'Store', orbitals: [
    { name: 'CartPage', entity: 'CartItem', pages: [], traits: [emitter] },
    { name: 'CheckoutPage', entity: 'Checkout', pages: [], traits: [listener] },
  ] });
  it('rejects a listener aimed at another orbital', () => {
    expect(auditListens(app(handler({ kind: 'orbital', orbital: 'OtherPage', trait: 'Cart' }))).missing).toHaveLength(1);
  });
  it('rejects a trait-local source in another orbital', () => {
    expect(auditListens(app(handler({ kind: 'trait', trait: 'Cart' }))).missing).toHaveLength(1);
  });
  it('does not count a payload declaration as a subscription', () => {
    expect(auditListens(app(handler())).missing).toHaveLength(1);
  });
  it('does not credit another orbital same-name self-transition', () => {
    expect(auditListens(app(trait({ name: 'Cart', stateMachine: machine([{ from: 'idle', event: 'CHECKOUT_STARTED', to: 'active', effects: [['set', '@entity.active', true]] }]) }))).missing).toHaveLength(1);
  });
  it('accepts an exact declared cross-orbital route', () => {
    expect(auditListens(app(handler({ kind: 'orbital', orbital: 'CartPage', trait: 'Cart' }))).missing).toEqual([]);
  });
  it('accepts an explicit wildcard route', () => {
    expect(auditListens(app(handler({ kind: 'any' }))).missing).toEqual([]);
  });
});


describe('identity and effect emit audit controls', () => {
  const orbitalId = OrbitalIdSchema.parse('orb_cart');
  const traitId = TraitIdSchema.parse('trt_cart');
  const eventId = EventIdSchema.parse('evt_checkout');
  const source = { kind: 'orbital' as const, orbital: 'OldCart', trait: 'OldBrowse', orbitalId, traitId };
  const app = (id = eventId): OrbitalSchema => ({ name: 'Store', orbitals: [
    { name: 'RenamedCart', id: orbitalId, entity: 'CartItem', pages: [], traits: [trait({ name: 'RenamedBrowse', id: traitId, emits: [{ event: 'RENAMED_CHECKOUT', eventId, scope: 'external' }] })] },
    { name: 'Checkout', entity: 'Checkout', pages: [], traits: [trait({ name: 'Wizard', listens: [{ event: 'RENAMED_CHECKOUT', eventId: id, triggers: 'START', source }] })] },
  ] });
  it('credits stable source identities after source renames', () => {
    expect(auditListens(app()).missing).toEqual([]);
  });
  it('preserves canonical name-based fanout across different event identities', () => {
    expect(auditListens(app(EventIdSchema.parse('evt_other'))).missing).toEqual([]);
  });
  it('does not substitute source names when an identity is missing', () => {
    const value = app();
    delete value.orbitals[0].id;
    expect(auditListens(value).missing).toHaveLength(1);
  });
  it('includes effect outcome emits only when requested by composition', () => {
    const value = schema([trait({ name: 'Cart', emits: [{ event: 'CHECKOUT_STARTED', scope: 'external' }],
      stateMachine: machine([{ from: 'idle', event: 'BUY', to: 'idle', effects: [['persist', 'create', 'Checkout', { emit: { success: 'CHECKOUT_STARTED' } }]] }]),
    })]);
    expect(auditListens(value).missing).toEqual([]);
    expect(auditListens(value, { includeEffectEmits: true }).missing).toEqual([{ orbital: 'Fixture', trait: 'Cart', event: 'CHECKOUT_STARTED', suggestion: 'listens { Cart.CHECKOUT_STARTED -> CHECKOUT_STARTED }' }]);
    value.orbitals[0].traits.push(trait({ name: 'Checkout', listens: [{ event: 'CHECKOUT_STARTED', triggers: 'START', source: { kind: 'trait', trait: 'Cart' } }] }));
    expect(auditListens(value, { includeEffectEmits: true }).missing).toEqual([]);
  });
});

describe('composition required effect routes', () => {
  it('preserves unused outcomes and broadcasts, then reports an existing unconnected handler', () => {
    const value = schema([trait({ name: 'Cart', emits: [{ event: 'CHECKOUT_STARTED', scope: 'external' }, { event: 'SAVED', scope: 'external' }],
      stateMachine: machine([{ from: 'idle', event: 'BUY', to: 'idle', effects: [['emit', 'CHECKOUT_STARTED'], ['persist', 'create', 'Checkout', { emit: { success: 'SAVED' } }]] }]),
    })]);
    expect(auditListens(value, { includeEffectEmits: 'with-declared-handler' }).missing).toEqual([]);
    value.orbitals[0].traits.push(trait({ name: 'CheckoutRules', stateMachine: machine([{ from: 'idle', event: 'CHECKOUT_STARTED', to: 'active', effects: [['set', '@entity.started', true]] }]) }));
    expect(auditListens(value, { includeEffectEmits: 'with-declared-handler' }).missing.map((finding) => finding.event)).toEqual(['CHECKOUT_STARTED']);
  });
});
