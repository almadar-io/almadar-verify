import { describe, it, expect } from 'vitest';
import type { Trait } from '@almadar/core';
import { traitBootRenderSlots } from '../orbital-walk.js';

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
