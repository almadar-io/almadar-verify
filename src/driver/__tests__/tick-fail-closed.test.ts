import { describe, it, expect } from 'vitest';
import type { EdgeWalkTransition } from '@almadar/core';
import { tick } from '../tick.js';
import { createFakeDriver, type FakeDriverContext } from '../impls/fake.js';
import type { Driver, SendResult } from '../types.js';
import type { TraitWalkConfig } from '../../engine/types.js';
import type { ExtendedWalkStep } from '../../planner/types.js';

function transition(from: string, event: string, to: string): EdgeWalkTransition {
  return { from, event, to, hasGuard: false };
}

const trait: TraitWalkConfig = {
  traitName: 'BrowseItemBrowse',
  initialState: 'loading',
  transitions: [
    transition('loading', 'INIT', 'loading'),
    transition('loading', 'BrowseItemLoaded', 'browsing'),
  ],
};

function step(
  from: string,
  event: string,
  to: string,
  triggerKind: ExtendedWalkStep['triggerKind'] = 'bus',
): ExtendedWalkStep {
  return {
    from,
    event,
    to,
    guardCase: null,
    payload: {},
    isRepositioning: triggerKind === 'replay',
    traitName: trait.traitName,
    triggerKind,
    coverageKey: `${trait.traitName}:${from}+${event}->${to}`,
  };
}

describe('tick — fail-closed dispatch', () => {
  it('fails closed when the driver reports sent=false', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    const ctx: FakeDriverContext = { outputDir: '/tmp', trait, runtime };

    // Wrap the fake driver so `sendEvent` reports a failed dispatch
    // (sent: false) while still advancing the underlying runtime — the
    // state still moves, but the kernel must NOT credit it.
    const failingDriver: Driver<FakeDriverContext> = {
      ...driver,
      async sendEvent(c, event, payload, scope): Promise<SendResult> {
        const real = await driver.sendEvent(c, event, payload, scope);
        return { sent: false, serverResponse: real.serverResponse };
      },
    };

    const init = await tick(failingDriver, ctx, null, step('loading', 'INIT', 'loading', 'auto-init'));
    const frame = await tick(failingDriver, ctx, init, step('loading', 'BrowseItemLoaded', 'browsing'));

    expect(frame.accepted).toBe(false);
    expect(frame.errors.length).toBeGreaterThan(0);
    expect(frame.errors.some((e) => e.includes('dispatch failed'))).toBe(true);
  });

  it('fails closed when getState returns null and allowStateless is unset', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    const ctx: FakeDriverContext = { outputDir: '/tmp', trait, runtime };

    // Stateless driver: dispatch succeeds (sent: true) but getState
    // returns null. Without allowStateless the frame must fail closed.
    const statelessDriver: Driver<FakeDriverContext> = {
      ...driver,
      async getState(): Promise<string | null> {
        return null;
      },
    };

    const init = await tick(statelessDriver, ctx, null, step('loading', 'INIT', 'loading', 'auto-init'));
    const frame = await tick(statelessDriver, ctx, init, step('loading', 'BrowseItemLoaded', 'browsing'));

    expect(frame.accepted).toBe(false);
    expect(frame.errors.some((e) => e.includes('stateless dispatch'))).toBe(true);
  });

  it('credits a null-state dispatch when allowStateless is set', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    const ctx: FakeDriverContext = { outputDir: '/tmp', trait, runtime };

    const statelessDriver: Driver<FakeDriverContext> = {
      ...driver,
      async getState(): Promise<string | null> {
        return null;
      },
    };

    const init = await tick(statelessDriver, ctx, null, step('loading', 'INIT', 'loading', 'auto-init'), undefined, true);
    const frame = await tick(statelessDriver, ctx, init, step('loading', 'BrowseItemLoaded', 'browsing'), undefined, true);

    expect(frame.errors.length).toBe(0);
    expect(frame.accepted).toBe(true);
  });
});
