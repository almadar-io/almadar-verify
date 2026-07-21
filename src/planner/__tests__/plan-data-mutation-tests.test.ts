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

  it('GAP 3 — skips a persist-bearing transition whose triggering event is effect-emitted (std-data-erasure ExecScanLoaded shape)', () => {
    // ExecScanLoaded is fired by a fetch's `emit.success`, not a user
    // affordance. In production its `data` payload comes from a real
    // fetch against the live store, so `@entity.id` extracted from it is
    // a real row id; a directly-synthesized test payload can't correlate
    // with the mock store's actual seeded rows, so the subsequent
    // `persist` finding no matching row is a test-harness artifact, not
    // a real bug — this transition must not be planned at all.
    const erasureLike: OrbitalSchema = {
      ...cart,
      orbitals: [
        {
          ...cart.orbitals[0],
          traits: [
            {
              name: 'ErasureWorkflow',
              scope: 'collection',
              linkedEntity: 'CartItem',
              stateMachine: {
                states: [{ name: 'idle', isInitial: true }, { name: 'execScanning' }],
                events: [
                  { key: 'INIT', name: 'Init' },
                  { key: 'ExecScanLoaded', name: 'Scan loaded', payloadSchema: [{ name: 'data', type: 'array' }] },
                ],
                transitions: [
                  {
                    from: 'idle',
                    to: 'execScanning',
                    event: 'ExecScanLoaded',
                    effects: [
                      ['fetch', 'CartItem', { emit: { success: 'ExecScanLoaded', failure: 'ExecScanFailed' } }],
                      ['persist', 'update', 'CartItem', { id: '@entity.id' }, { emit: { success: 'ExecStepped' } }],
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(planDataMutationTests(erasureLike)).toEqual([]);
  });

  it('still plans a persist-bearing transition triggered by a real user event, even when the trait ALSO effect-emits other events', () => {
    const mixed: OrbitalSchema = {
      ...cart,
      orbitals: [
        {
          ...cart.orbitals[0],
          traits: [
            {
              name: 'Mixed',
              scope: 'collection',
              linkedEntity: 'CartItem',
              stateMachine: {
                states: [{ name: 'idle', isInitial: true }, { name: 'browsing' }],
                events: [
                  { key: 'INIT', name: 'Init' },
                  { key: 'FETCHED', name: 'Fetched' },
                  { key: 'CANCEL', name: 'Cancel' },
                ],
                transitions: [
                  {
                    from: 'idle',
                    to: 'browsing',
                    event: 'FETCHED',
                    effects: [['fetch', 'CartItem', { emit: { success: 'FETCHED' } }]],
                  },
                  {
                    from: 'browsing',
                    to: 'idle',
                    event: 'CANCEL',
                    effects: [['persist', 'update', 'CartItem', { id: '@payload.id' }, { emit: { success: 'CANCELLED' } }]],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const steps = planDataMutationTests(mixed);
    expect(steps).toHaveLength(1);
    expect(steps[0].event).toBe('CANCEL');
  });

});
