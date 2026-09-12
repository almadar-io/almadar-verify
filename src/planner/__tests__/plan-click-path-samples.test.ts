import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { planClickPathSamples } from '../plan-click-path-samples.js';

const cartWithButtons: OrbitalSchema = {
  name: 'cart',
  designTokens: {},
  customPatterns: {},
  orbitals: [
    {
      name: 'CartOrbital',
      entity: { name: 'CartItem', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
      pages: [],
      traits: [
        {
          name: 'CartItemBrowse',
          scope: 'collection',
          stateMachine: {
            states: [{ name: 'browsing', isInitial: true }],
            events: [
              { key: 'INIT', name: 'Init' },
              { key: 'ADD_ITEM', name: 'Add' },
              { key: 'REMOVE_ITEM', name: 'Remove' },
            ],
            transitions: [
              {
                from: 'browsing',
                to: 'browsing',
                event: 'INIT',
                effects: [
                  ['render-ui', 'main', {
                    type: 'stack',
                    children: [
                      { type: 'button', action: 'ADD_ITEM', label: 'Add' },
                      {
                        type: 'data-grid',
                        itemActions: [
                          { type: 'button', action: 'REMOVE_ITEM', label: 'Remove' },
                        ],
                      },
                    ],
                  }],
                ],
              },
            ],
          },
        },
      ],
    },
  ],
};

describe('planClickPathSamples', () => {
  it('emits one dom step per (slot, event) render site found in render-ui effects', () => {
    const steps = planClickPathSamples(cartWithButtons);
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step.triggerKind).toBe('dom');
      expect(step.testKind).toBe('click-path');
      expect(step.from).toBe('browsing');
      expect(step.to).toBe('browsing');
      expect(step.coverageKey).toMatch(/\[click-path:main\]/);
    }
    expect(steps.map((s) => s.event).sort()).toEqual(['ADD_ITEM', 'REMOVE_ITEM']);
  });

  it('returns [] when no traits have render-ui actions', () => {
    const noActions: OrbitalSchema = {
      ...cartWithButtons,
      orbitals: [
        {
          ...cartWithButtons.orbitals[0],
          traits: [
            {
              name: 'X',
              scope: 'collection',
              stateMachine: {
                states: [{ name: 'a', isInitial: true }],
                events: [{ key: 'GO', name: 'Go' }],
                transitions: [{ from: 'a', to: 'a', event: 'GO' }],
              },
            },
          ],
        },
      ],
    };
    expect(planClickPathSamples(noActions)).toEqual([]);
  });

  it('deduplicates the same (trait, slot, event) seen across multiple transitions', () => {
    const dupe: OrbitalSchema = {
      ...cartWithButtons,
      orbitals: [
        {
          ...cartWithButtons.orbitals[0],
          traits: [
            {
              name: 'X',
              scope: 'collection',
              stateMachine: {
                states: [{ name: 'a', isInitial: true }, { name: 'b' }],
                events: [{ key: 'GO', name: 'Go' }, { key: 'INIT', name: 'Init' }],
                transitions: [
                  {
                    from: 'a',
                    to: 'a',
                    event: 'INIT',
                    effects: [['render-ui', 'main', { type: 'button', action: 'GO' }]],
                  },
                  {
                    from: 'b',
                    to: 'b',
                    event: 'INIT',
                    effects: [['render-ui', 'main', { type: 'button', action: 'GO' }]],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(planClickPathSamples(dupe)).toHaveLength(1);
  });

  it('stamps navigates: true for a click-path step whose target transition is navigate-back', () => {
    const withBack: OrbitalSchema = {
      ...cartWithButtons,
      orbitals: [
        {
          ...cartWithButtons.orbitals[0],
          traits: [
            {
              name: 'DetailAppLayout',
              scope: 'instance',
              stateMachine: {
                states: [{ name: 'idle', isInitial: true }],
                events: [{ key: 'INIT', name: 'Init' }, { key: 'BACK', name: 'Back' }],
                transitions: [
                  {
                    from: 'idle',
                    to: 'idle',
                    event: 'INIT',
                    effects: [
                      ['render-ui', 'main', { type: 'button', action: 'BACK', label: 'Back' }],
                    ],
                  },
                  { from: 'idle', to: 'idle', event: 'BACK', effects: [['navigate-back']] },
                ],
              },
            },
          ],
        },
      ],
    };
    const steps = planClickPathSamples(withBack);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.event).toBe('BACK');
    expect(steps[0]?.navigates).toBe(true);
  });

  it('does not stamp navigates for a click-path step whose target transition has no navigation effect', () => {
    const steps = planClickPathSamples(cartWithButtons);
    for (const step of steps) {
      expect(step.navigates).toBeUndefined();
    }
  });

  it('returns [] when traits have no stateMachine', () => {
    const noSM: OrbitalSchema = {
      ...cartWithButtons,
      orbitals: [
        {
          ...cartWithButtons.orbitals[0],
          traits: [{ name: 'NoSM', scope: 'collection' }],
        },
      ],
    };
    expect(planClickPathSamples(noSM)).toEqual([]);
  });
});

describe('planClickPathSamples — a guarded affordance carries its guard preamble', () => {
  it('attaches DRAFT_CHANGED before clicking a composer Send guarded on the draft', () => {
    const orbital: OrbitalSchema = {
      name: 'efficacy-chat',
      version: '1.0.0',
      orbitals: [{
        name: 'ChatMessageOrbital',
        entity: { name: 'ChatMessage', fields: [{ name: 'id', type: 'string', required: true }, { name: 'draft', type: 'string' }, { name: 'activeChannel', type: 'string' }] },
        pages: [],
        traits: [{
          name: 'ChatComposer',
          scope: 'instance',
          linkedEntity: 'ChatMessage',
          stateMachine: {
            states: [{ name: 'ready', isInitial: true }],
            events: [
              { key: 'INIT', name: 'Init' },
              { key: 'DRAFT_CHANGED', name: 'Draft Changed', payloadSchema: [{ name: 'value', type: 'string' }] },
              { key: 'SEND', name: 'Send' },
            ],
            transitions: [
              {
                from: 'ready', to: 'ready', event: 'INIT',
                effects: [
                  ['set', '@entity.draft', ''],
                  ['set', '@entity.activeChannel', 'general'],
                  ['render-ui', 'main', { type: 'stack', children: [{ type: 'textarea', onChange: 'DRAFT_CHANGED' }, { type: 'button', action: 'SEND', label: 'Send' }] }],
                ],
              },
              { from: 'ready', to: 'ready', event: 'DRAFT_CHANGED', effects: [['set', '@entity.draft', '@payload.value']] },
              {
                from: 'ready', to: 'ready', event: 'SEND',
                guard: ['and', '@entity.activeChannel', ['not', ['=', ['str/default', '@entity.draft', ''], '']]],
                effects: [['emit', 'SAVE', { data: { content: '@entity.draft' } }]],
              },
            ],
          },
        }],
      }],
    };
    const steps = planClickPathSamples(orbital);
    const send = steps.find((s) => s.event === 'SEND');
    expect(send?.establishesRow?.event).toBe('DRAFT_CHANGED');
    expect(send?.establishesRow?.beforeReplay).toBe(true);
  });
});
