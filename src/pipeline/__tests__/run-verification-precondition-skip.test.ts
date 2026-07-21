/**
 * GAP 3 regression — a step whose `from` precondition can't be
 * established must be skipped, not dispatched from a stale state.
 *
 * Mirrors std-approval-gate exactly: `APPROVE` only exists in
 * `reviewing`, reached via `idle --OPEN--> loading
 * --(effect-emitted)ApprovalRequestLoaded--> reviewing`. Pre-fix,
 * `planReplayTo`'s BFS excludes effect-emitted edges as hops and never
 * checked the landing state's transient closure, so `reviewing` was
 * "unreachable" and the kernel dispatched APPROVE straight from `idle`
 * (frame evidence: stateBefore/stateAfter both `idle`).
 */

import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';
import { extractTraitWalkConfigs } from '../../planner/extract-trait-walk-configs.js';

function approvalGateOrbital(): OrbitalSchema {
  return {
    name: 'std-approval-gate-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'ApprovalRequestOrbital',
        entity: {
          name: 'ApprovalRequest',
          persistence: 'runtime',
          fields: [{ name: 'id', type: 'string', required: true }],
        },
        pages: [
          { name: 'ApprovalRequestPage', path: '/approvalrequests', traits: [{ ref: 'ApprovalGateReview' }] },
        ],
        traits: [
          {
            name: 'ApprovalGateReview',
            scope: 'collection',
            linkedEntity: 'ApprovalRequest',
            stateMachine: {
              states: [
                { name: 'idle', isInitial: true },
                { name: 'loading' },
                { name: 'reviewing' },
                { name: 'error' },
              ],
              events: [
                { key: 'INIT', name: 'Initialize' },
                { key: 'OPEN', name: 'Open' },
                { key: 'ApprovalRequestLoaded', name: 'Loaded' },
                { key: 'ApprovalRequestLoadFailed', name: 'Load failed' },
                { key: 'APPROVE', name: 'Approve' },
              ],
              transitions: [
                { from: 'idle', to: 'idle', event: 'INIT' },
                {
                  from: 'idle',
                  to: 'loading',
                  event: 'OPEN',
                  effects: [['fetch', 'ApprovalRequest', { emit: { success: 'ApprovalRequestLoaded', failure: 'ApprovalRequestLoadFailed' } }]],
                },
                { from: 'loading', to: 'reviewing', event: 'ApprovalRequestLoaded' },
                { from: 'loading', to: 'error', event: 'ApprovalRequestLoadFailed' },
                { from: 'reviewing', to: 'reviewing', event: 'APPROVE' },
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
  enableEmitSweep: false,
  log: () => {},
};

describe('runVerification — precondition-unreachable steps are skipped, not misfired', () => {
  it('drives OPEN through the reconcile preamble and fires APPROVE validly once the effect settles into reviewing', async () => {
    const orbital = approvalGateOrbital();
    const traits = extractTraitWalkConfigs(orbital);
    const { driver, runtime } = createFakeDriver(traits);

    // Simulate the mocked fetch settling inside the driver's settle
    // window — same technique as run-verification-reconcile-race.test.ts.
    const originalSendEvent = driver.sendEvent.bind(driver);
    driver.sendEvent = async (ctx, event, payload, scope) => {
      const result = await originalSendEvent(ctx, event, payload, scope);
      if (event === 'OPEN') runtime.setState(ctx.trait.traitName, 'reviewing');
      return result;
    };

    const result = await runVerification({
      itemName: 'std-approval-gate-fixture',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: baseOptions,
    });

    expect(result.verdicts.preconditionSkipped).toBeUndefined();
    expect(result.verdicts.replayDiverged).toBeUndefined();
    const approveFrame = result.frames.find((f) => f.cause.event === 'APPROVE');
    expect(approveFrame).toBeDefined();
    expect(approveFrame?.stateBefore).toBe('reviewing');
    expect(approveFrame?.accepted).toBe(true);
  });

  it('skips APPROVE (does not dispatch it from a stale state) when reviewing is genuinely unreachable', async () => {
    // Same shape, but with the loading->reviewing link removed entirely —
    // `reviewing` has no incoming edge at all, so no reconcile/closure
    // fix can reach it. The old behavior dispatched APPROVE from `idle`
    // anyway (stateBefore === stateAfter === 'idle'); the fix must skip
    // the step outright instead.
    const orbital = approvalGateOrbital();
    const gate = orbital.orbitals[0].traits[0];
    if (typeof gate === 'string' || !('stateMachine' in gate) || gate.stateMachine === undefined) {
      throw new Error('fixture shape changed');
    }
    gate.stateMachine.transitions = gate.stateMachine.transitions.filter(
      (t) => t.event !== 'ApprovalRequestLoaded',
    );

    const traits = extractTraitWalkConfigs(orbital);
    const { driver, runtime } = createFakeDriver(traits);

    const result = await runVerification({
      itemName: 'std-approval-gate-fixture-unreachable',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: baseOptions,
    });

    expect(result.frames.some((f) => f.cause.event === 'APPROVE')).toBe(false);
    expect(result.verdicts.preconditionSkipped).toBeDefined();
    expect(result.verdicts.preconditionSkipped?.passed).toBe(true);
    expect(result.verdicts.preconditionSkipped?.detail).toContain('APPROVE');
  });

  it('still fails a transition that IS reachable and diverges (real bug, not a skip)', async () => {
    // reviewing is reachable via the closure fix, but force the reconcile
    // hop to land somewhere OUTSIDE loading's closure entirely — a
    // genuine divergence must still surface as replayDiverged, and
    // APPROVE must still be skipped (its precondition never held) rather
    // than silently passing.
    const orbital = approvalGateOrbital();
    const traits = extractTraitWalkConfigs(orbital);
    const { driver, runtime } = createFakeDriver(traits);

    const originalSendEvent = driver.sendEvent.bind(driver);
    driver.sendEvent = async (ctx, event, payload, scope) => {
      const result = await originalSendEvent(ctx, event, payload, scope);
      if (event === 'OPEN') runtime.setState(ctx.trait.traitName, 'rogue-state');
      return result;
    };

    const result = await runVerification({
      itemName: 'std-approval-gate-fixture-diverge',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: baseOptions,
    });

    expect(result.verdicts.replayDiverged?.passed).toBe(false);
    expect(result.verdicts.preconditionSkipped?.passed).toBe(true);
    expect(result.frames.some((f) => f.cause.event === 'APPROVE')).toBe(false);
  });
});
