import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, SExpr, TransitionTrace, VerificationSnapshot } from '@almadar/core';
import { assertPropositionHeld } from '../assert-proposition-held.js';
import type { Frame, FrameCause } from '../../frame/types.js';
import { testKernel } from '../../kernel/__tests__/test-kernel.js';

const ensures: SExpr = ['=', '@entity.balance', ['-', '@fromEntity.balance', '@payload.amount']];

const schema: OrbitalSchema = {
  name: 'wallet',
  orbitals: [{
    name: 'WalletOrbital',
    entity: { name: 'Account', persistence: 'runtime', fields: [{ name: 'balance', type: 'number', default: 100 }] },
    pages: [],
    traits: [{
      name: 'Wallet',
      scope: 'instance',
      linkedEntity: 'Account',
      stateMachine: {
        states: [{ name: 'active', isInitial: true }],
        events: [{ key: 'SPEND', name: 'Spend' }, { key: 'TOP_UP', name: 'Top up' }],
        transitions: [
          { from: 'active', to: 'active', event: 'SPEND', ensures: [ensures], effects: [['set', '@entity.balance', ['-', '@entity.balance', '@payload.amount']]] },
          { from: 'active', to: 'active', event: 'TOP_UP', effects: [['set', '@entity.balance', 1000]] },
        ],
      },
    }],
  }],
};

const cause: FrameCause = { traitName: 'Wallet', from: 'active', event: 'SPEND', to: 'active', guardCase: null, triggerKind: 'dom', isRepositioning: false };

function hop(id: string, event: string, before: number, after: number, effectType = 'set'): TransitionTrace {
  return {
    id,
    traitName: 'Wallet',
    from: 'active',
    to: 'active',
    event,
    effects: [{ type: effectType, args: [], status: 'executed' }],
    observed: { firedArm: 0, payload: { amount: 3 }, entityBefore: { balance: before }, entityAfter: { balance: after } },
    timestamp: 1,
  };
}

function frame(index: number, transitions: TransitionTrace[]): Frame {
  const runtimeSnapshot: VerificationSnapshot = {
    checks: [],
    transitions,
    bridge: null,
    summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
    traits: [],
  };
  return {
    index,
    timestamp: 1000 + index,
    cause,
    stateBefore: 'active',
    stateAfter: 'active',
    payload: { amount: 3 },
    eventFired: 'SPEND',
    runtimeSnapshot,
    domSnapshot: { url: '', rowsByEntity: {}, portals: [], visibleTextSample: '' },
    consoleDelta: { added: [], newErrors: 0, newWarnings: 0 },
    eventLogDelta: { added: [] },
    entityChanges: [],
    effectResults: [],
    serverResponse: null,
    screenshotPath: null,
    accepted: true,
    errors: [],
    warnings: [],
  };
}

describe('assertPropositionHeld', () => {
  it('a hop that keeps its @ensures passes', async () => {
    const v = await assertPropositionHeld([frame(0, [hop('t1', 'SPEND', 10, 7)])], schema, testKernel);
    expect(v?.passed).toBe(true);
  });

  it('a wrong value in the right state fails, naming the hop', async () => {
    const v = await assertPropositionHeld([frame(0, [hop('t1', 'SPEND', 10, 8)])], schema, testKernel);
    expect(v?.passed).toBe(false);
    expect(v?.detail).toMatch(/Wallet: active --SPEND--> active/);
    expect(v?.evidence?.frameIndices).toEqual([0]);
  });

  it('each hop is judged once, in the frame it first appears in', async () => {
    const first = hop('t1', 'SPEND', 10, 8);
    const v = await assertPropositionHeld([frame(0, [first]), frame(1, [first, hop('t2', 'SPEND', 7, 4)])], schema, testKernel);
    expect(v?.evidence?.frameIndices).toEqual([0]);
  });

  it('control: a hop without @ensures, or without an observation, owes nothing', async () => {
    const unobserved: TransitionTrace = { ...hop('t3', 'SPEND', 0, 0), observed: undefined };
    const v = await assertPropositionHeld([frame(0, [hop('t2', 'TOP_UP', 10, 1000), unobserved])], schema, testKernel);
    expect(v).toBeUndefined();
  });

  it('a hop whose persist the page cannot observe is inconclusive, never a pass or a failure', async () => {
    const v = await assertPropositionHeld([frame(0, [hop('t1', 'SPEND', 10, 10, 'persist')])], schema, testKernel);
    expect(v?.passed).toBe(true);
    expect(v?.detail).toMatch(/inconclusive/);
  });
});
