/**
 * Tick-driven trait end-to-end fixture.
 *
 * Mirrors prototypes/snake/snake.lolo's shape: one trait owns the whole
 * loop — a numeric-interval tick (`step every … when (not @entity.over)`),
 * entity-bound guarded steering transitions, and a declared `emits {}`
 * contract block. Runs `runVerification` against the FakeDriver and pins:
 *   - the tick gets a wait-and-observe frame (enableTickTests default on),
 *   - contract-declared events get emit-sweep frames,
 *   - entity-bound guard variants don't trip guardParity (unsteerable),
 *   - coverage reports one schema-honest number: 6 transitions + 1 tick.
 */

import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';
import { extractTraitWalkConfigs } from '../../planner/extract-trait-walk-configs.js';

const entityGuard = (opposite: string): ['and', ['not', string], ['!=', string, string]] => [
  'and',
  ['not', '@entity.over'],
  ['!=', '@entity.dir', opposite],
];

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
              { key: 'UP', name: 'Up', payloadSchema: [{ name: 'id', type: 'string' }] },
              { key: 'DOWN', name: 'Down', payloadSchema: [{ name: 'id', type: 'string' }] },
              { key: 'RESTART', name: 'Restart', payloadSchema: [{ name: 'id', type: 'string' }] },
            ],
            transitions: [
              { from: 'playing', to: 'playing', event: 'INIT' },
              { from: 'playing', to: 'playing', event: 'UP', guard: entityGuard('down') },
              { from: 'playing', to: 'playing', event: 'DOWN', guard: entityGuard('up') },
              { from: 'playing', to: 'playing', event: 'RESTART' },
              // Self-received internal contract emit — a real snake.lolo-shaped
              // atom listens for its own INTERNAL_PING; without a receiving
              // transition the emit-sweep's `acceptedEvents` filter (no trait
              // anywhere accepts it) correctly treats it as an orphaned
              // broadcast (the GAME_END/no-handler case) and skips the sweep.
              { from: 'playing', to: 'playing', event: 'INTERNAL_PING' },
            ],
          },
          ticks: [
            {
              name: 'step',
              interval: 20,
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

function run(extra: { enableTickTests?: boolean; enableEmitSweep?: boolean } = {}) {
  const traits = extractTraitWalkConfigs(snake);
  const { driver, runtime } = createFakeDriver(traits);
  return runVerification({
    itemName: 'std-snake',
    orbital: snake,
    driver,
    ctx: { outputDir: '', runtime },
    options: {
      enableInteractionTests: false,
      enableContractEvents: false,
      enableDataMutationTests: false,
      enableClickPathSamples: false,
      enablePortalPerStep: false,
      enableUserCrudFlow: false,
      log: () => {},
      ...extra,
    },
  });
}

describe('runVerification — tick-driven trait (snake-shaped)', () => {
  it('executes a wait-and-observe tick frame by default', async () => {
    const result = await run();
    const tickFrames = result.frames.filter((f) => f.cause.triggerKind === 'tick');
    expect(tickFrames).toHaveLength(1);
    expect(tickFrames[0].cause.event).toBe('step');
    expect(tickFrames[0].accepted).toBe(true);
    expect(tickFrames[0].stateAfter).toBe('playing');
  });

  it('suppresses tick steps when enableTickTests is false', async () => {
    const result = await run({ enableTickTests: false });
    expect(result.frames.some((f) => f.cause.triggerKind === 'tick')).toBe(false);
    expect(result.coverage.totalItems).toBe(5); // schema transitions only
  });

  it('fires contract-declared events through the emit sweep (internal AND external)', async () => {
    const result = await run();
    const emitKeys = result.frames
      .map((f) => f.cause.coverageKey)
      .filter((k): k is string => k !== undefined && k.endsWith('[emit]'));
    expect(emitKeys).toContain('Snake:playing+UP->playing[emit]');
    expect(emitKeys).toContain('Snake:playing+INTERNAL_PING->playing[emit]');
  });

  it('entity-bound guard variants are marked unsteerable and guardParity passes', async () => {
    const result = await run();
    const guarded = result.frames.filter((f) => f.cause.guardCase !== null);
    expect(guarded.length).toBeGreaterThan(0);
    expect(guarded.every((f) => f.cause.guardSteerable === false)).toBe(true);
    expect(result.verdicts.guardParity?.passed).toBe(true);
  });

  it('reports one schema-honest coverage number: 5 transitions + 1 tick', async () => {
    const result = await run();
    expect(result.coverage.schemaTransitions).toBe(5);
    expect(result.coverage.totalItems).toBe(6);
    expect(result.coverage.coveredItems).toBe(6);
    expect(result.coverage.ratio).toBe(1);
    expect(result.coverage.uncovered).toEqual([]);
    expect(result.coverage.perTriggerKind.tick).toEqual({ total: 1, covered: 1 });
  });
});
