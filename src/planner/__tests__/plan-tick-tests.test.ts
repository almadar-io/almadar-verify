import { describe, it, expect } from 'vitest';
import type { TraitTick } from '@almadar/core';
import { planTickTests } from '../plan-tick-tests.js';
import type { TraitWalkConfig } from '../../engine/types.js';

// Snake-inspired: a single trait with a numeric-interval tick advancing
// the game loop (`step every 150ms when (not @entity.over) …`).
const snakeTick: TraitTick = {
  name: 'step',
  interval: 150,
  guard: ['not', '@entity.over'],
  effects: [['set', '@entity.over', true]],
};

const trait: TraitWalkConfig = {
  traitName: 'Snake',
  initialState: 'playing',
  transitions: [
    { from: 'playing', event: 'INIT', to: 'playing', hasGuard: false },
    { from: 'playing', event: 'UP', to: 'playing', hasGuard: true, guard: ['not', '@entity.over'] },
  ],
  ticks: [snakeTick],
};

describe('planTickTests', () => {
  it('emits one tick-wait step per numeric-interval tick', () => {
    const steps = planTickTests({ trait });
    expect(steps).toHaveLength(1);
    const [step] = steps;
    expect(step.triggerKind).toBe('tick');
    expect(step.traitName).toBe('Snake');
    expect(step.event).toBe('step');
    expect(step.from).toBe('playing');
    expect(step.to).toBe('playing');
    expect(step.waitMs).toBe(150);
    expect(step.coverageKey).toBe('Snake:tick(step)');
  });

  it('accepts any declared state after the wait (tick effects may move the trait)', () => {
    const [step] = planTickTests({ trait });
    expect(step.acceptStates).toBeDefined();
    expect([...(step.acceptStates ?? [])].sort()).toEqual(['playing']);
  });

  it("skips 'frame'-interval ticks — no wall-clock interval to wait out", () => {
    const frameTick: TraitTick = {
      name: 'render',
      interval: 'frame',
      effects: [['set', '@entity.x', 1]],
    };
    const steps = planTickTests({ trait: { ...trait, ticks: [frameTick] } });
    expect(steps).toHaveLength(0);
  });

  it('skips non-positive numeric intervals (invalid per the core schema)', () => {
    const badTick: TraitTick = {
      name: 'bad',
      interval: 0,
      effects: [['set', '@entity.x', 1]],
    };
    const steps = planTickTests({ trait: { ...trait, ticks: [badTick] } });
    expect(steps).toHaveLength(0);
  });

  it('returns [] when the trait declares no ticks', () => {
    const { ticks: _ticks, ...noTicks } = trait;
    expect(planTickTests({ trait: noTicks })).toEqual([]);
  });

  it('plans one step per declared tick when several exist', () => {
    const second: TraitTick = {
      name: 'spawn',
      interval: 3000,
      effects: [['set', '@entity.food', { x: 1, y: 1 }]],
    };
    const steps = planTickTests({ trait: { ...trait, ticks: [snakeTick, second] } });
    expect(steps.map((s) => s.coverageKey).sort()).toEqual([
      'Snake:tick(spawn)',
      'Snake:tick(step)',
    ]);
    expect(steps.map((s) => s.waitMs).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([150, 3000]);
  });
});
