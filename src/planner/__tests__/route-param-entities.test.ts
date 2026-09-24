// A `:param` page is walked under a real row id of the entity its INIT fetch declares — shaped after std-winning-11's /connections/:id.
import { describe, it, expect, vi } from 'vitest';
import type { EntityRow, OrbitalSchema, Trait, Transition } from '@almadar/core';
import { extractTraitWalkConfigs } from '../extract-trait-walk-configs.js';
import { fillRouteParams } from '../../driver/helpers/fill-route-params.js';

function trait(name: string, linkedEntity: string, initEffects: Transition['effects']): Trait {
  return {
    name,
    scope: 'instance',
    linkedEntity,
    stateMachine: {
      states: [{ name: 'loading', isInitial: true }, { name: 'viewing' }],
      events: [{ key: 'INIT', name: 'Init' }],
      transitions: [
        { from: 'loading', to: 'loading', event: 'INIT', effects: initEffects },
        { from: 'viewing', to: 'loading', event: 'INIT', effects: [['fetch', 'Connection', { id: '@entity.id' }]] },
      ],
    },
  };
}

const schema: OrbitalSchema = {
  name: 'route-params',
  orbitals: [
    {
      name: 'ConnectivityOrbital',
      entity: { name: 'Connection', persistence: 'persistent', fields: [{ name: 'id', type: 'string' }] },
      pages: [
        { name: 'ConnectionsPage', path: '/connections', traits: [{ ref: 'ConnectionBrowse' }] },
        { name: 'ConnectionDetailPage', path: '/connections/:id', traits: [{ ref: 'ConnectionDetail' }, { ref: 'SelfDetail' }] },
        { name: 'MembersPage', path: '/teams/:teamId/members', traits: [{ ref: 'MemberList' }] },
        { name: 'PairPage', path: '/pairs/:left/:right', traits: [{ ref: 'PairView' }] },
      ],
      traits: [
        trait('ConnectionBrowse', 'Connection', [['fetch', 'Connection', {}]]),
        trait('ConnectionDetail', 'Connection', [['set', '@entity.id', '@payload.id'], ['fetch', 'Connection', { id: '@payload.id' }]]),
        trait('SelfDetail', 'Connection', [['fetch', '@entity', { id: '@payload.id' }]]),
        trait('MemberList', 'TeamMember', [['fetch', 'TeamMember', { filter: ['=', '@entity.teamId', '@payload.teamId'] }]]),
        trait('PairView', 'Pair', [['fetch', 'Person', { id: '@payload.left' }]]),
      ],
    },
  ],
};

function configFor(name: string) {
  const config = extractTraitWalkConfigs(schema).find((c) => c.traitName === name);
  expect(config).toBeDefined();
  return config;
}

describe('routeParamEntities', () => {
  it('maps a :param to the entity its page INIT fetches by that param', () => {
    expect(configFor('ConnectionDetail')?.routeParamEntities).toEqual({ id: 'Connection' });
  });

  it('resolves an `@entity` fetch to the trait\'s linked entity', () => {
    expect(configFor('SelfDetail')?.routeParamEntities).toEqual({ id: 'Connection' });
  });

  it('leaves a param that only feeds a filter undeclared', () => {
    expect(configFor('MemberList')?.routeParamEntities).toBeUndefined();
  });

  it('maps only the params the page actually fetches by', () => {
    expect(configFor('PairView')?.routeParamEntities).toEqual({ left: 'Person' });
  });

  it('carries nothing for a route with no params', () => {
    expect(configFor('ConnectionBrowse')?.routeParamEntities).toBeUndefined();
  });
});

describe('fillRouteParams', () => {
  const rows: Record<string, EntityRow[]> = {
    Connection: [{ id: 'c-1' }, { id: 'c-2' }],
    Person: [{ id: 'p/1' }],
    Empty: [],
  };
  const listRows = vi.fn(async (entity: string) => rows[entity] ?? []);

  it('fills a declared param with the first real row id', async () => {
    expect(await fillRouteParams('connections/:id', { id: 'Connection' }, listRows)).toBe('connections/c-1');
  });

  it('keeps an undeclared param literal so the walk fails honestly', async () => {
    expect(await fillRouteParams('pairs/:left/:right', { left: 'Person' }, listRows)).toBe('pairs/p%2F1/:right');
  });

  it('keeps the param literal when the entity has no rows', async () => {
    expect(await fillRouteParams('things/:id', { id: 'Empty' }, listRows)).toBe('things/:id');
  });

  it('is a no-op without a route, a mapping, or a row lister', async () => {
    listRows.mockClear();
    expect(await fillRouteParams(undefined, { id: 'Connection' }, listRows)).toBeUndefined();
    expect(await fillRouteParams('connections/:id', undefined, listRows)).toBe('connections/:id');
    expect(await fillRouteParams('connections/:id', { id: 'Connection' }, undefined)).toBe('connections/:id');
    expect(listRows).not.toHaveBeenCalled();
  });
});
