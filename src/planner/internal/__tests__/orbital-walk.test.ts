import { describe, it, expect } from 'vitest';
import type { Effect, Orbital, OrbitalSchema, Trait } from '@almadar/core';
import { dispatchNavigates, traitBootRenderSlots, transitionNavigates } from '../orbital-walk.js';

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
