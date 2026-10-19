import { describe, it, expect } from 'vitest';
import type { Effect, Orbital, OrbitalSchema, Trait } from '@almadar/core';
import { dispatchNavigates, emitLands, traitBootRenderSlots, transitionNavigates } from '../orbital-walk.js';

describe('traitBootRenderSlots', () => {
  it('returns empty for a portal-only trait whose INIT transition never renders (std-modal-shaped)', () => {
    const modalTrait: Trait = {
      name: 'ModalRecordModal',
      scope: 'instance',
      stateMachine: {
        states: [{ name: 'closed', isInitial: true }, { name: 'open' }],
        events: [{ key: 'INIT', name: 'Init' }, { key: 'OPEN', name: 'Open' }],
        transitions: [
          { from: 'closed', to: 'closed', event: 'INIT', effects: [['fetch', 'ModalRecord', {}]] },
          { from: 'closed', to: 'open', event: 'OPEN', effects: [['render-ui', 'modal', { type: 'stack' }]] },
        ],
      },
    };

    expect(traitBootRenderSlots(modalTrait)).toEqual(new Set());
  });

  it('collects the slot a trait DOES render into at boot (browse-shaped)', () => {
    const browseTrait: Trait = {
      name: 'BrowseItemBrowse',
      scope: 'collection',
      stateMachine: {
        states: [{ name: 'loading', isInitial: true }, { name: 'browsing' }],
        events: [{ key: 'INIT', name: 'Init' }],
        transitions: [
          { from: 'loading', to: 'loading', event: 'INIT', effects: [['render-ui', 'main', { type: 'stack' }]] },
        ],
      },
    };

    expect(traitBootRenderSlots(browseTrait)).toEqual(new Set(['main']));
  });

  it('returns empty when the trait has no state machine', () => {
    const trait: Trait = { name: 'X', scope: 'instance' };
    expect(traitBootRenderSlots(trait)).toEqual(new Set());
  });

  it('ignores render-ui effects on non-INIT or non-initial-state transitions', () => {
    const trait: Trait = {
      name: 'Y',
      scope: 'instance',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }, { name: 'open' }],
        events: [{ key: 'INIT', name: 'Init' }, { key: 'OPEN', name: 'Open' }],
        transitions: [
          { from: 'idle', to: 'idle', event: 'INIT', effects: [] },
          { from: 'idle', to: 'open', event: 'OPEN', effects: [['render-ui', 'main', { type: 'stack' }]] },
        ],
      },
    };
    expect(traitBootRenderSlots(trait)).toEqual(new Set());
  });
});

describe('transitionNavigates', () => {
  it('is true for a literal navigate effect', () => {
    const effects: Effect[] = [['navigate', '/notes']];
    expect(transitionNavigates(effects)).toBe(true);
  });

  it('is true for navigate-back — the second (and only other) route-changing effect head', () => {
    const effects: Effect[] = [['navigate-back']];
    expect(transitionNavigates(effects)).toBe(true);
  });

  it('is false for a transition with no navigation effect', () => {
    const effects: Effect[] = [['emit', 'DONE', {}]];
    expect(transitionNavigates(effects)).toBe(false);
  });

  it('is false for undefined effects', () => {
    expect(transitionNavigates(undefined)).toBe(false);
  });
});

describe('dispatchNavigates', () => {
  // NoteSubpages-shaped fixture: the DISPATCHED trait (Subpages) never
  // navigates on SELECT_RELATED — a listener (BacklinksRouter) does, on the
  // arm SELECT_RELATED triggers (SELECT). Same class as
  // `NoteBacklinksRouter listens NoteSubpages.SELECT_RELATED -> SELECT_RELATED`.
  function orbitalWith(listenerEffects: Effect[]): { schema: OrbitalSchema; orbital: Orbital } {
    const orbital: Orbital = {
      name: 'NoteOrbital',
      entity: { name: 'Note', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [
        {
          name: 'Subpages',
          scope: 'instance',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [{ key: 'SELECT_RELATED', name: 'SelectRelated' }],
            transitions: [
              { from: 'idle', to: 'idle', event: 'SELECT_RELATED', effects: [['emit', 'SELECT_RELATED', {}]] },
            ],
          },
          emits: [{ event: 'SELECT_RELATED', scope: 'external' }],
        },
        {
          name: 'BacklinksRouter',
          scope: 'instance',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [{ key: 'SELECT', name: 'Select' }],
            transitions: [{ from: 'idle', to: 'idle', event: 'SELECT', effects: listenerEffects }],
          },
          listens: [
            {
              event: 'SELECT_RELATED',
              triggers: 'SELECT',
              scope: 'external',
              source: { kind: 'trait', trait: 'Subpages' },
            },
          ],
        },
      ],
      pages: [],
    };
    const schema: OrbitalSchema = { name: 'NoteApp', designTokens: {}, customPatterns: {}, orbitals: [orbital] };
    return { schema, orbital };
  }

  it('is true when only a LISTENER\'s triggered arm navigates — the dispatched trait itself never does', () => {
    const { schema, orbital } = orbitalWith([['navigate', '/notes/related']]);
    expect(dispatchNavigates(schema, orbital, 'Subpages', 'SELECT_RELATED')).toBe(true);
  });

  it('is undefined-equivalent (false) when the listener\'s triggered arm does not navigate either', () => {
    const { schema, orbital } = orbitalWith([['set', '@entity.selected', '@payload.key']]);
    expect(dispatchNavigates(schema, orbital, 'Subpages', 'SELECT_RELATED')).toBe(false);
  });

  it('is true when the dispatched transition itself navigates (no listener involved)', () => {
    const orbital: Orbital = {
      name: 'O',
      entity: { name: 'Thing', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [
        {
          name: 'DetailLayout',
          scope: 'instance',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [{ key: 'BACK', name: 'Back' }],
            transitions: [{ from: 'idle', to: 'idle', event: 'BACK', effects: [['navigate-back']] }],
          },
        },
      ],
      pages: [],
    };
    const schema: OrbitalSchema = { name: 'App', designTokens: {}, customPatterns: {}, orbitals: [orbital] };
    expect(dispatchNavigates(schema, orbital, 'DetailLayout', 'BACK')).toBe(true);
  });
});

describe('emitLands', () => {
  // std-confirmation-shaped: Delete owns CANCEL/CONFIRM arms only in `confirming`; a persistor listens to
  // Delete.CONFIRM; Other has its own unrelated CANCEL arm in `idle`.
  function confirmProgram(listenSource: 'trait' | 'any' | 'none'): { schema: OrbitalSchema; orbital: Orbital } {
    const orbital: Orbital = {
      name: 'ContactOrbital',
      entity: { name: 'Contact', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [
        {
          name: 'Delete',
          scope: 'instance',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }, { name: 'confirming' }],
            events: [{ key: 'REQUEST', name: 'Request' }, { key: 'CONFIRM', name: 'Confirm' }, { key: 'CANCEL', name: 'Cancel' }],
            transitions: [
              { from: 'idle', to: 'confirming', event: 'REQUEST', effects: [] },
              { from: 'confirming', to: 'idle', event: 'CONFIRM', effects: [] },
              { from: 'confirming', to: 'idle', event: 'CANCEL', effects: [] },
            ],
          },
          emits: [{ event: 'CONFIRM', scope: 'external' }, { event: 'CANCEL', scope: 'external' }],
        },
        {
          name: 'Persistor',
          scope: 'instance',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [{ key: 'DO_DELETE', name: 'DoDelete' }],
            transitions: [{ from: 'idle', to: 'idle', event: 'DO_DELETE', effects: [] }],
          },
          listens: listenSource === 'none' ? [] : [{
            event: 'CONFIRM',
            triggers: 'DO_DELETE',
            scope: 'external',
            source: listenSource === 'any' ? { kind: 'any' } : { kind: 'trait', trait: 'Delete' },
          }],
        },
        {
          name: 'Other',
          scope: 'instance',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [{ key: 'CANCEL', name: 'Cancel' }],
            transitions: [{ from: 'idle', to: 'idle', event: 'CANCEL', effects: [] }],
          },
        },
      ],
      pages: [],
    };
    return { schema: { name: 'App', designTokens: {}, customPatterns: {}, orbitals: [orbital] }, orbital };
  }

  it('is false for an emit no listener hears and the emitter has no arm for in the sweep state, whatever other traits handle the same name', () => {
    const { schema, orbital } = confirmProgram('trait');
    expect(emitLands(schema, orbital, 'Delete', 'idle', 'CANCEL')).toBe(false);
  });

  it('is true when the emitter itself handles the event from the sweep state', () => {
    const { schema, orbital } = confirmProgram('trait');
    expect(emitLands(schema, orbital, 'Delete', 'confirming', 'CANCEL')).toBe(true);
  });

  it('is true when a listener sourced on the emitter triggers an arm, and for a wildcard listen', () => {
    expect(emitLands(confirmProgram('trait').schema, confirmProgram('trait').orbital, 'Delete', 'idle', 'CONFIRM')).toBe(true);
    expect(emitLands(confirmProgram('any').schema, confirmProgram('any').orbital, 'Delete', 'idle', 'CONFIRM')).toBe(true);
  });

  it('is false when the only listener is gone', () => {
    const { schema, orbital } = confirmProgram('none');
    expect(emitLands(schema, orbital, 'Delete', 'idle', 'CONFIRM')).toBe(false);
  });

  it('hears a legacy `Source.EVENT` listen address, and a bare unsourced name hears nothing', () => {
    const legacy = confirmProgram('none');
    const persistor = legacy.orbital.traits[1];
    if (typeof persistor === 'string' || !('stateMachine' in persistor)) throw new Error('fixture');
    persistor.listens = [{ event: 'Delete.CONFIRM', triggers: 'DO_DELETE', scope: 'external' }];
    expect(emitLands(legacy.schema, legacy.orbital, 'Delete', 'idle', 'CONFIRM')).toBe(true);
    persistor.listens = [{ event: 'CONFIRM', triggers: 'DO_DELETE', scope: 'external' }];
    expect(emitLands(legacy.schema, legacy.orbital, 'Delete', 'idle', 'CONFIRM')).toBe(false);
  });

  it('is false for a listener sourced on a different trait', () => {
    const { schema, orbital } = confirmProgram('trait');
    expect(emitLands(schema, orbital, 'Other', 'idle', 'CONFIRM')).toBe(false);
  });
});
