import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { extractTraitWalkConfigs } from '../extract-trait-walk-configs.js';

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
