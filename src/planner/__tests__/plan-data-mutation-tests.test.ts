import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { planDataMutationTests } from '../plan-data-mutation-tests.js';

const cart: OrbitalSchema = {
  name: 'cart',
  designTokens: {},
  customPatterns: {},
  orbitals: [
    {
      name: 'CartOrbital',
      entity: { name: 'CartItem', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] },
      pages: [],
      traits: [
        {
          name: 'CartItemAddItem',
          scope: 'instance',
          linkedEntity: 'CartItem',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }, { name: 'form' }, { name: 'confirming' }],
            events: [
              { key: 'INIT', name: 'Init' },
              { key: 'OPEN', name: 'Open' },
              { key: 'SAVE', name: 'Save' },
              { key: 'OPEN_DELETE', name: 'Open delete' },
              { key: 'CONFIRM_DELETE', name: 'Confirm delete' },
              { key: 'EDIT', name: 'Edit' },
            ],
            transitions: [
              { from: 'idle', to: 'form', event: 'OPEN' },
              {
                from: 'form',
                to: 'idle',
                event: 'SAVE',
                effects: [['persist', 'create', 'CartItem', { from: '@payload.data' }]],
              },
              {
                from: 'idle',
                to: 'confirming',
                event: 'OPEN_DELETE',
              },
              {
                from: 'confirming',
                to: 'idle',
                event: 'CONFIRM_DELETE',
                effects: [['persist', 'delete', 'CartItem', { id: '@payload.id' }]],
              },
              {
                from: 'form',
                to: 'idle',
                event: 'EDIT',
                effects: [['persist', 'update', 'CartItem', { from: '@payload.data' }]],
              },
            ],
          },
        },
      ],
    },
  ],
};

describe('planDataMutationTests', () => {
  it('emits one dom step per persist effect, with expectedRowDelta sized by kind', () => {
    const steps = planDataMutationTests(cart);
    expect(steps).toHaveLength(3);

    const create = steps.find((s) => s.event === 'SAVE');
    const remove = steps.find((s) => s.event === 'CONFIRM_DELETE');
    const update = steps.find((s) => s.event === 'EDIT');

    expect(create?.expectedRowDelta).toEqual({ entityName: 'CartItem', delta: 1 });
    expect(remove?.expectedRowDelta).toEqual({ entityName: 'CartItem', delta: -1 });
    expect(update?.expectedRowDelta).toEqual({ entityName: 'CartItem', delta: 0 });
  });

  it('all emitted steps are dom + data-mutation', () => {
    const steps = planDataMutationTests(cart);
    for (const step of steps) {
      expect(step.triggerKind).toBe('dom');
      expect(step.testKind).toBe('data-mutation');
      expect(step.coverageKey).toMatch(/\[data-mutation:(create|delete|update)\]/);
    }
  });

  it('skips transitions without persist effects', () => {
    const noPersist: OrbitalSchema = {
      ...cart,
      orbitals: [
        {
          ...cart.orbitals[0],
          traits: [
            {
              name: 'NoPersist',
              scope: 'collection',
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
    expect(planDataMutationTests(noPersist)).toEqual([]);
  });

});
