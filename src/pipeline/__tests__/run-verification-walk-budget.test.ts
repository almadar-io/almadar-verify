/**
 * DEFECT 2/3 regression (2026-09-03, runtime-verify tool-layer bugs).
 *
 * DEFECT 2: a walk truncated by `maxWalkMs`/`maxFrames` must surface as a
 * distinct, structured `result.walkBudget` entry — never collapse into an
 * anonymous `uncovered transition` warning indistinguishable from a real
 * authoring bug (a dead/unreachable transition).
 *
 * DEFECT 3: a many-armed `match @entity.op` atom lowers into N guarded
 * transitions sharing one `(from, event, to)`. The walker can't force a
 * non-default arm (`guardIsPayloadSteerable` correctly marks these
 * unsteerable), so coverage of the other arms depends entirely on
 * `planEmitSweep` bus-firing each arm's declared completion event — but
 * extension steps (including the emit sweep) are appended AFTER the base
 * topology walk in the SAME per-trait budget (`run-verification.ts`:
 * `const plan = [...baseSteps, ...extensionSteps]`). A many-armed match's
 * base-variant fan-out (malformed/guard-fail/guard-pass × N arms) can
 * exhaust the budget before the emit-sweep tail ever runs — this is the
 * exact std-service-calendar symptom (6/7 arms' `*Done` events never
 * dispatched), reproduced here deterministically via `maxFrames` instead
 * of wall-clock timing.
 */

import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';
import { extractTraitWalkConfigs } from '../../planner/extract-trait-walk-configs.js';

const ARM_COUNT = 5;

/** A `match @entity.op` atom lowered into ARM_COUNT guarded EXEC arms
 *  sharing (idle, EXEC, executing), each with its own completion event —
 *  mirrors std-service-calendar's shape. */
function manyArmedMatchOrbital(): OrbitalSchema {
  const armTransitions = Array.from({ length: ARM_COUNT }, (_, i) => ({
    from: 'idle',
    to: 'executing',
    event: 'EXEC',
    guard: ['==', '@entity.op', `op${i}`],
    effects: [['call-service', 'svc', { action: `op${i}`, emit: { success: `Arm${i}Done`, failure: `Arm${i}Failed` } }]],
  }));
  const completionTransitions = Array.from({ length: ARM_COUNT }, (_, i) => ({
    from: 'executing',
    to: 'idle',
    event: `Arm${i}Done`,
  }));
  const completionEvents = Array.from({ length: ARM_COUNT }, (_, i) => ({ key: `Arm${i}Done`, name: `Arm ${i} done` }));

  return {
    name: 'std-service-many-arm-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'ServiceManyArmOrbital',
        entity: {
          name: 'ServiceManyArm',
          persistence: 'runtime',
          fields: [{ name: 'id', type: 'string', required: true }, { name: 'op', type: 'string', required: false }],
        },
        pages: [
          { name: 'ServiceManyArmPage', path: '/servicemanyarms', traits: [{ ref: 'ServiceManyArm' }] },
        ],
        traits: [
          {
            name: 'ServiceManyArm',
            scope: 'collection',
            linkedEntity: 'ServiceManyArm',
            stateMachine: {
              states: [
                { name: 'idle', isInitial: true },
                { name: 'executing' },
              ],
              events: [
                { key: 'INIT', name: 'Initialize' },
                { key: 'EXEC', name: 'Execute' },
                ...completionEvents,
              ],
              transitions: [
                { from: 'idle', to: 'idle', event: 'INIT' },
                ...armTransitions,
                ...completionTransitions,
              ],
            },
          },
        ],
      },
    ],
  };
}

const baseOptions = {
  enableInteractionTests: false,
  enableContractEvents: false,
  enableDataMutationTests: false,
  enableClickPathSamples: false,
  enablePortalPerStep: false,
  enableUserCrudFlow: false,
  enableTickTests: false,
  log: () => {},
};

describe('runVerification — walk-budget-exceeded is a distinct, structured outcome', () => {
  it('records a maxFrames-truncated trait in result.walkBudget, not an anonymous warning', async () => {
    const orbital = manyArmedMatchOrbital();
    const traits = extractTraitWalkConfigs(orbital);
    const { driver, runtime } = createFakeDriver(traits);

    const result = await runVerification({
      itemName: 'walk-budget-fixture',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: { ...baseOptions, enableEmitSweep: false, maxFrames: 3 },
    });

    expect(result.walkBudget).toBeDefined();
    expect(result.walkBudget?.length).toBe(1);
    const entry = result.walkBudget?.[0];
    expect(entry?.traitName).toBe('ServiceManyArm');
    expect(entry?.reason).toBe('maxFrames');
    expect(entry?.stepsCompleted).toBeLessThan(entry?.totalSteps ?? 0);
    expect(entry?.stepsUnreached).toBeGreaterThan(0);
  });

  it('does not report walkBudget when the plan finishes inside its budget', async () => {
    const orbital = manyArmedMatchOrbital();
    const traits = extractTraitWalkConfigs(orbital);
    const { driver, runtime } = createFakeDriver(traits);

    const result = await runVerification({
      itemName: 'walk-budget-fixture-clean',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: { ...baseOptions, enableEmitSweep: false, maxFrames: 5_000 },
    });

    expect(result.walkBudget).toBeUndefined();
  });

  it('DEFECT 3 mechanism: a tight budget starves the emit-sweep tail before any non-default arm completion event dispatches', async () => {
    const orbital = manyArmedMatchOrbital();
    const traits = extractTraitWalkConfigs(orbital);
    const { driver, runtime } = createFakeDriver(traits);

    // Tight enough to exhaust the base topology walk's malformed/guard-fail/
    // guard-pass fan-out (up to 3 variants × ARM_COUNT arms) before the
    // emit-sweep extension (appended after base steps) gets a turn.
    const result = await runVerification({
      itemName: 'walk-budget-fixture-emit-sweep-starved',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: { ...baseOptions, enableEmitSweep: true, maxFrames: 4 },
    });

    expect(result.walkBudget).toBeDefined();
    const armDoneDispatched = result.frames.some((f) => f.cause.event.endsWith('Done'));
    expect(armDoneDispatched).toBe(false);
  });

  it('a generous budget lets every arm completion event reach the emit sweep', async () => {
    const orbital = manyArmedMatchOrbital();
    const traits = extractTraitWalkConfigs(orbital);
    const { driver, runtime } = createFakeDriver(traits);

    const result = await runVerification({
      itemName: 'walk-budget-fixture-emit-sweep-clean',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: { ...baseOptions, enableEmitSweep: true, maxFrames: 5_000 },
    });

    expect(result.walkBudget).toBeUndefined();
    for (let i = 0; i < ARM_COUNT; i++) {
      expect(result.frames.some((f) => f.cause.event === `Arm${i}Done`)).toBe(true);
    }
  });

  it('surfaces a maxWalkMs-truncated trait with reason "maxWalkMs" when the wall-clock budget fires first', async () => {
    const orbital = manyArmedMatchOrbital();
    const traits = extractTraitWalkConfigs(orbital);
    const { driver, runtime } = createFakeDriver(traits);

    // Inject a real per-dispatch delay so Date.now() progresses past a tiny
    // maxWalkMs — maxFrames stays generous so maxWalkMs is what fires.
    const originalSendEvent = driver.sendEvent.bind(driver);
    driver.sendEvent = async (ctx, event, payload, scope) => {
      await new Promise((r) => setTimeout(r, 15));
      return originalSendEvent(ctx, event, payload, scope);
    };

    const result = await runVerification({
      itemName: 'walk-budget-fixture-ms',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: { ...baseOptions, enableEmitSweep: false, maxFrames: 5_000, maxWalkMs: 10 },
    });

    expect(result.walkBudget).toBeDefined();
    expect(result.walkBudget?.[0].reason).toBe('maxWalkMs');
  });
});
