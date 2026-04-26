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
