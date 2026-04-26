import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { planInteractionTests } from '../plan-interaction-tests.js';

const cart: OrbitalSchema = {
  name: 'cart',
  designTokens: {},
  customPatterns: {},
  orbitals: [
    {
      name: 'CartOrbital',
      entity: {
        name: 'CartItem',
        persistence: 'persistent',
        fields: [
          { name: 'id', type: 'string', required: true },
          { name: 'name', type: 'string', required: true },
          { name: 'description', type: 'string' },
        ],
      },
      pages: [],
      traits: [
        {
          name: 'CartItemAddItem',
          scope: 'instance',
          linkedEntity: 'CartItem',
          stateMachine: {
            states: [
              { name: 'idle', isInitial: true },
              { name: 'form' },
            ],
            events: [
              { key: 'INIT', name: 'Init' },
              { key: 'ADD_ITEM', name: 'Add' },
              {
                key: 'SAVE',
                name: 'Save',
                payloadSchema: [
                  { name: 'name', type: 'string', required: true },
                  { name: 'description', type: 'string' },
                ],
              },
              { key: 'CANCEL', name: 'Cancel' },
            ],
            transitions: [
              // INIT renders the list with an "Add" button that fires
              // ADD_ITEM. This is the orbital-wide DOM affordance the
              // interaction-test planner looks for.
              {
                from: 'idle',
                to: 'idle',
                event: 'INIT',
                effects: [['render-ui', 'main', {
                  type: 'stack',
                  children: [
                    { type: 'button', label: 'Add', action: 'ADD_ITEM' },
                  ],
                }]],
              },
              {
                from: 'idle',
                to: 'form',
                event: 'ADD_ITEM',
                effects: [['render-ui', 'modal', { type: 'modal', children: [] }]],
              },
              {
                from: 'form',
                to: 'idle',
                event: 'SAVE',
                effects: [['render-ui', 'modal', {
                  type: 'form-section',
                  fields: [{ name: 'name' }],
                  submitEvent: 'SAVE',
                }]],
              },
              {
                from: 'form',
                to: 'idle',
                event: 'CANCEL',
              },
            ],
          },
        },
      ],
    },
  ],
};

describe('planInteractionTests', () => {
  it('emits a dom step per transition with a render-ui target', () => {
    const steps = planInteractionTests(cart);
    // Two render-ui transitions: ADD_ITEM (modal), SAVE (form-section).
    // CANCEL has no render-ui → no test.
    const interactions = steps.filter((s) => s.testKind === 'interaction');
    expect(interactions).toHaveLength(2);
  });

  it('marks the form transition with formData built from the payload schema', () => {
    const steps = planInteractionTests(cart);
    const save = steps.find((s) => s.event === 'SAVE');
    expect(save?.expectedPattern).toBe('form-section');
    expect(save?.formData).toBeDefined();
    expect(save?.formData?.name).toBeDefined();
    expect(save?.formData?.description).toBeDefined();
  });

  it('non-form interactions get expectedPattern but no formData', () => {
    const steps = planInteractionTests(cart);
    const add = steps.find((s) => s.event === 'ADD_ITEM');
    expect(add?.expectedPattern).toBe('modal');
    expect(add?.formData).toBeUndefined();
  });

  it('replay path is expanded inline as triggerKind: replay steps before each interaction', () => {
    const steps = planInteractionTests(cart);
    // SAVE fires from `form`, which is reachable from `idle` via ADD_ITEM.
    // So SAVE's interaction step should be preceded by a replay step.
    const idx = steps.findIndex((s) => s.event === 'SAVE' && s.testKind === 'interaction');
    expect(idx).toBeGreaterThan(0);
    const prev = steps[idx - 1];
    expect(prev.triggerKind).toBe('replay');
    expect(prev.event).toBe('ADD_ITEM');
  });

  it('skips transitions with no render-ui (e.g. CANCEL)', () => {
    const steps = planInteractionTests(cart);
    expect(steps.find((s) => s.event === 'CANCEL')).toBeUndefined();
  });

  it('returns [] for an orbital with no render-ui transitions', () => {
    const noUi: OrbitalSchema = {
      ...cart,
      orbitals: [
        {
          ...cart.orbitals[0],
          traits: [
            {
              name: 'X',
              scope: 'instance',
              stateMachine: {
                states: [{ name: 'a', isInitial: true }, { name: 'b' }],
                events: [{ key: 'GO', name: 'Go' }],
                transitions: [{ from: 'a', to: 'b', event: 'GO' }],
              },
            },
          ],
        },
      ],
    };
    expect(planInteractionTests(noUi)).toEqual([]);
  });
});
