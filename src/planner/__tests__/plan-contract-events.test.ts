import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import {
  planContractEvents,
  type ContractRegistry,
} from '../plan-contract-events.js';

const cart: OrbitalSchema = {
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
            events: [{ key: 'INIT', name: 'Init' }],
            transitions: [
              {
                from: 'browsing',
                to: 'browsing',
                event: 'INIT',
                effects: [
                  ['render-ui', 'main', {
                    type: 'data-grid',
                    entity: 'CartItem',
                    fields: [{ type: 'typography', name: 'name' }],
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

describe('planContractEvents', () => {
  it('emits one dom step per non-optional contract emit for patterns actually used', () => {
    const registry: ContractRegistry = {
      'data-grid': { emits: [{ event: 'SELECT' }, { event: 'UPDATE' }, { event: 'DELETE' }] },
      'unused-pattern': { emits: [{ event: 'NOPE' }] },
    };
    const steps = planContractEvents(cart, registry);
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.event).sort()).toEqual(['DELETE', 'SELECT', 'UPDATE']);
    for (const step of steps) {
      expect(step.testKind).toBe('contract');
      expect(step.triggerKind).toBe('dom');
      expect(step.coverageKey).toMatch(/\[contract:data-grid\]/);
    }
  });

  it('skips optional emits', () => {
    const registry: ContractRegistry = {
      'data-grid': { emits: [{ event: 'SELECT' }, { event: 'HOVER', optional: true }] },
    };
    const steps = planContractEvents(cart, registry);
    expect(steps).toHaveLength(1);
    expect(steps[0].event).toBe('SELECT');
  });

  it('skips events already covered (passed via alreadyCovered set)', () => {
    const registry: ContractRegistry = {
      'data-grid': { emits: [{ event: 'SELECT' }, { event: 'UPDATE' }] },
    };
    const steps = planContractEvents(cart, registry, new Set(['SELECT']));
    expect(steps).toHaveLength(1);
    expect(steps[0].event).toBe('UPDATE');
  });

  it('returns [] when no patterns in the registry are used by the orbital', () => {
    const registry: ContractRegistry = { 'unused': { emits: [{ event: 'X' }] } };
    expect(planContractEvents(cart, registry)).toEqual([]);
  });

  it('returns [] when registry is empty', () => {
    expect(planContractEvents(cart, {})).toEqual([]);
  });
});
