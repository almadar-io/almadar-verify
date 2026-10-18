import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, Trait, TraitEventListener, Transition } from '@almadar/core';
import { extractTraitWalkConfigs } from '../extract-trait-walk-configs.js';
import { walkSteps } from '../../kernel/adapt.js';
import { kernelPlan } from '../../kernel/__tests__/kernel-steps.js';

// Snake-inspired single-trait orbital: numeric-interval tick, guarded
// self-transitions, and a declared `emits {}` contract block.
const snake: OrbitalSchema = {
  name: 'std-snake',
  designTokens: {},
  customPatterns: {},
  orbitals: [
    {
      name: 'SnakeOrbital',
      entity: {
        name: 'SnakeGame',
        persistence: 'runtime',
        fields: [{ name: 'id', type: 'string', required: true }],
      },
      pages: [{ name: 'SnakePage', path: '/snake', traits: [{ ref: 'Snake' }] }],
      traits: [
        {
          name: 'Snake',
          scope: 'instance',
          linkedEntity: 'SnakeGame',
          stateMachine: {
            states: [{ name: 'playing', isInitial: true }],
            events: [
              { key: 'INIT', name: 'Init' },
              { key: 'UP', name: 'Up' },
            ],
            transitions: [
              { from: 'playing', to: 'playing', event: 'INIT' },
              { from: 'playing', to: 'playing', event: 'UP', guard: ['not', '@entity.over'] },
            ],
          },
          ticks: [
            {
              name: 'step',
              interval: 150,
              guard: ['not', '@entity.over'],
              effects: [['set', '@entity.over', true]],
            },
          ],
          emits: [
            { event: 'UP', scope: 'external', payloadSchema: [{ name: 'id', type: 'string' }] },
            { event: 'INTERNAL_PING', scope: 'internal' },
          ],
        },
      ],
    },
  ],
};

describe('extractTraitWalkConfigs — schema-model fields', () => {
  it('populates ticks from the trait declaration', () => {
    const [config] = extractTraitWalkConfigs(snake);
    expect(config.ticks).toHaveLength(1);
    expect(config.ticks?.[0].name).toBe('step');
    expect(config.ticks?.[0].interval).toBe(150);
  });

  it('populates emitContracts (internal AND external scope)', () => {
    const [config] = extractTraitWalkConfigs(snake);
    expect(config.emitContracts?.map((c) => c.event).sort()).toEqual([
      'INTERNAL_PING',
      'UP',
    ]);
  });

  it('splits the events an http effect delivers on into reply and failure routes', () => {
    const [snakeTrait] = snake.orbitals[0].traits;
    if (typeof snakeTrait === 'string' || !('stateMachine' in snakeTrait) || snakeTrait.stateMachine === undefined) throw new Error('fixture trait has no state machine');
    const withHttp: OrbitalSchema = {
      ...snake,
      orbitals: [{
        ...snake.orbitals[0],
        traits: [{
          ...snakeTrait,
          stateMachine: {
            ...snakeTrait.stateMachine,
            transitions: [
              ...snakeTrait.stateMachine.transitions,
              { from: 'playing', to: 'playing', event: 'UP', effects: [['http', 'GET', 'https://api.example.com', '/items', {}, { emit: { success: 'ITEMS_REPLIED', failure: 'ITEMS_FAILED', cancelled: 'ITEMS_CANCELLED' } }]] },
            ],
          },
        }],
      }],
    };
    const [config] = extractTraitWalkConfigs(withHttp);
    expect([...(config.httpReplyEvents ?? [])].sort()).toEqual(['ITEMS_CANCELLED', 'ITEMS_REPLIED']);
    expect([...(config.httpFailureEvents ?? [])]).toEqual(['ITEMS_FAILED']);
  });

  describe('http routes follow delivery', () => {
    const trait = (name: string, transitions: Transition[], listens: TraitEventListener[] = []): Trait => ({
      name,
      scope: 'instance',
      linkedEntity: 'Thing',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }, { name: 'waiting' }, { name: 'done' }],
        events: [{ key: 'GO', name: 'Go' }, { key: 'DONE', name: 'Done' }, { key: 'GOT', name: 'Got' }],
        transitions,
      },
      ...(listens.length > 0 ? { listens } : {}),
    });
    const schema: OrbitalSchema = {
      name: 'routes',
      orbitals: [{
        name: 'O',
        entity: { name: 'Thing', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        pages: [],
        traits: [
          trait('Caller', [
            { from: 'idle', to: 'waiting', event: 'GO', effects: [['http', 'GET', 'https://api.example.com', '/x', {}, { emit: { success: 'DONE' } }]] },
            { from: 'waiting', to: 'done', event: 'DONE' },
          ]),
          trait('Plain', [{ from: 'idle', to: 'done', event: 'DONE' }]),
          trait('Watcher', [{ from: 'idle', to: 'done', event: 'GOT' }], [{ event: 'DONE', triggers: 'GOT', scope: 'internal', source: { kind: 'trait', trait: 'Caller' } }]),
          trait('Stranger', [{ from: 'idle', to: 'done', event: 'GOT' }], [{ event: 'DONE', triggers: 'GOT', scope: 'internal', source: { kind: 'trait', trait: 'Elsewhere' } }]),
        ],
      }],
    };
    const configs = extractTraitWalkConfigs(schema);
    const reply = (name: string) => [...(configs.find((c) => c.traitName === name)?.httpReplyEvents ?? [])];

    it('marks the emitting trait\'s own arm, not an ordinary arm on the same event name in another trait', () => {
      expect(reply('Caller')).toEqual(['DONE']);
      expect(reply('Plain')).toEqual([]);
    });

    it('control: the kernel planner walks Plain\'s DONE arm and skips Caller\'s', () => {
      const planned = kernelPlan(schema);
      const walked = (name: string) => walkSteps(planned, name, { includeAutoInit: false }).map((step) => step.event);
      expect(walked('Plain')).toContain('DONE');
      expect(walked('Caller')).not.toContain('DONE');
    });

    it('marks the listen\'s triggers event on a trait whose listen accepts the emitter, and not on one naming another source', () => {
      expect(reply('Watcher')).toEqual(['GOT']);
      expect(reply('Stranger')).toEqual([]);
    });
  });

  it('omits ticks and emitContracts when the trait declares none', () => {
    const bare: OrbitalSchema = {
      name: 'bare',
      designTokens: {},
      customPatterns: {},
      orbitals: [
        {
          name: 'BareOrbital',
          entity: { name: 'Bare', persistence: 'runtime', fields: [] },
          pages: [],
          traits: [
            {
              name: 'Bare',
              scope: 'instance',
              stateMachine: {
                states: [{ name: 'idle', isInitial: true }],
                events: [{ key: 'INIT', name: 'Init' }],
                transitions: [{ from: 'idle', to: 'idle', event: 'INIT' }],
              },
            },
          ],
        },
      ],
    };
    const [config] = extractTraitWalkConfigs(bare);
    expect(config.ticks).toBeUndefined();
    expect(config.emitContracts).toBeUndefined();
  });
});
