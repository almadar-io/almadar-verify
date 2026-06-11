import { describe, it, expect } from 'vitest';
import type { EdgeWalkTransition } from '@almadar/core';
import { tick } from '../tick.js';
import { createFakeDriver, type FakeDriverContext } from '../impls/fake.js';
import type { TraitWalkConfig } from '../../engine/types.js';
import type { ExtendedWalkStep } from '../../planner/types.js';
import type { Frame } from '../../frame/types.js';

function transition(from: string, event: string, to: string): EdgeWalkTransition {
  return { from, event, to, hasGuard: false };
}

const trait: TraitWalkConfig = {
  traitName: 'BrowseItemBrowse',
  initialState: 'loading',
  transitions: [
    transition('loading', 'INIT', 'loading'),
    transition('loading', 'BrowseItemLoaded', 'browsing'),
    transition('loading', 'BrowseItemLoadFailed', 'error'),
    transition('browsing', 'INIT', 'loading'),
    transition('error', 'INIT', 'loading'),
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

function makeCtx(): FakeDriverContext {
  return { outputDir: '/tmp', trait, runtime: undefined as unknown as never };
}

describe('tick', () => {
  it('produces a synthetic auto-init Frame without dispatching', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    const ctx = { outputDir: '/tmp', trait, runtime };
    const initStep = step('loading', 'INIT', 'loading', 'auto-init');

    const frame = await tick(driver, ctx, null, initStep);

    expect(frame.cause.triggerKind).toBe('auto-init');
    expect(frame.cause.event).toBe('INIT');
    expect(frame.stateBefore).toBeNull();
    expect(frame.stateAfter).toBe('loading');
    expect(frame.accepted).toBe(true);
    expect(frame.index).toBe(0);
  });

  it('fires sendEvent for bus steps and advances state', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    const ctx = { outputDir: '/tmp', trait, runtime };
    const init = await tick(driver, ctx, null, step('loading', 'INIT', 'loading', 'auto-init'));
    const next = await tick(driver, ctx, init, step('loading', 'BrowseItemLoaded', 'browsing'));

    expect(next.cause.event).toBe('BrowseItemLoaded');
    expect(next.stateBefore).toBe('loading');
    expect(next.stateAfter).toBe('browsing');
    expect(next.accepted).toBe(true);
    expect(next.index).toBe(1);
  });

  it('accepts a malformed-payloadCase step when the server rejects and state holds', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    const ctx = { outputDir: '/tmp', trait, runtime };
    // The API-boundary validator rejects the empty payload, so the
    // transition must NOT fire. The planner still tags `to` with the
    // success target; acceptance must measure "state held + rejected",
    // not "reached `to`".
    runtime.rejectEvent(trait.traitName, 'BrowseItemLoaded');
    const malformed: ExtendedWalkStep = {
      ...step('loading', 'BrowseItemLoaded', 'browsing'),
      payloadCase: 'malformed',
    };

    const frame = await tick(driver, ctx, null, malformed);

    expect(frame.stateBefore).toBe('loading');
    expect(frame.stateAfter).toBe('loading'); // held — validator rejected
    expect(frame.serverResponse?.success).toBe(false);
    expect(frame.accepted).toBe(true);
  });

  it('rejects a malformed-payloadCase step when the validator silently accepts bad input', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    const ctx = { outputDir: '/tmp', trait, runtime };
    // No rejectEvent: the fake advances the state machine, simulating a
    // server that accepted a malformed payload (a real validation gap).
    // The malformed contract requires state to HOLD, so this must fail.
    const malformed: ExtendedWalkStep = {
      ...step('loading', 'BrowseItemLoaded', 'browsing'),
      payloadCase: 'malformed',
    };

    const frame = await tick(driver, ctx, null, malformed);

    expect(frame.stateAfter).toBe('browsing'); // advanced — bad input accepted
    expect(frame.accepted).toBe(false);
  });

  it('accepts a settled state in the transient closure (acceptStates)', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    const ctx = { outputDir: '/tmp', trait, runtime };
    // The trait is in `browsing`. `browsing --INIT--> loading` fires, but
    // `loading` auto-advances to `browsing` (the planner supplied acceptStates
    // = the transient closure). The fake lands the trait in `loading` (no
    // auto-fetch), which is also in the closure → accepted.
    runtime.dispatch(trait.traitName, 'BrowseItemLoaded'); // loading → browsing
    const refresh: ExtendedWalkStep = {
      ...step('browsing', 'INIT', 'loading'),
      acceptStates: ['loading', 'browsing', 'error'],
    };

    const frame = await tick(driver, ctx, null, refresh);

    expect(frame.stateBefore).toBe('browsing');
    expect(frame.stateAfter).toBe('loading'); // in the closure
    expect(frame.accepted).toBe(true);
  });

  it('rejects a state outside the transient closure', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    const ctx = { outputDir: '/tmp', trait, runtime };
    runtime.dispatch(trait.traitName, 'BrowseItemLoaded'); // loading → browsing
    // browsing --INIT--> loading in the fake → loading, but acceptStates only
    // lists `error` (an unreachable settled state) → not in closure → rejected.
    const refresh: ExtendedWalkStep = {
      ...step('browsing', 'INIT', 'loading'),
      acceptStates: ['error'],
    };
    const frame = await tick(driver, ctx, null, refresh);
    expect(frame.stateAfter).toBe('loading');
    expect(frame.accepted).toBe(false);
  });

  it('fires triggerDOM for dom steps', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    const ctx = { outputDir: '/tmp', trait, runtime };
    const init = await tick(driver, ctx, null, step('loading', 'INIT', 'loading', 'auto-init'));
    const domStep = step('loading', 'BrowseItemLoaded', 'browsing', 'dom');
    const next = await tick(driver, ctx, init, domStep);

    expect(next.stateAfter).toBe('browsing');
    expect(next.cause.triggerKind).toBe('dom');
  });

  it('walks the std-browse fixture end-to-end via tick', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    const ctx = { outputDir: '/tmp', trait, runtime };
    const plan: ExtendedWalkStep[] = [
      step('loading', 'INIT', 'loading', 'auto-init'),
      step('loading', 'BrowseItemLoaded', 'browsing'),
      step('browsing', 'INIT', 'loading'),
      step('loading', 'BrowseItemLoadFailed', 'error'),
      step('error', 'INIT', 'loading'),
    ];

    const frames: Frame[] = [];
    let prev: Frame | null = null;
    for (const s of plan) {
      const f: Frame = await tick(driver, ctx, prev, s);
      frames.push(f);
      prev = f;
    }

    expect(frames).toHaveLength(5);
    expect(frames.every((f) => f.accepted)).toBe(true);
    // Final state should be `loading` (the last step's `to`).
    expect(frames[frames.length - 1].stateAfter).toBe('loading');
  });

  it('marks the frame not accepted when state does not move as expected', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    const ctx = { outputDir: '/tmp', trait, runtime };
    const init = await tick(driver, ctx, null, step('loading', 'INIT', 'loading', 'auto-init'));
    // Fire an event the trait doesn't have a transition for from `loading`.
    const bogus = step('loading', 'NONEXISTENT', 'browsing');
    const frame = await tick(driver, ctx, init, bogus);

    // FakeRuntime won't advance state; stateAfter stays `loading`.
    expect(frame.stateAfter).toBe('loading');
    expect(frame.accepted).toBe(false);
  });
});

describe('FakeDriver', () => {
  it('exposes traits via VerificationSnapshot', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    const ctx = { outputDir: '/tmp', trait, runtime };
    const snap = await driver.snapshot(ctx, null);
    expect(snap.runtimeSnapshot.traits).toHaveLength(1);
    expect(snap.runtimeSnapshot.traits[0].traitName).toBe('BrowseItemBrowse');
    expect(snap.runtimeSnapshot.traits[0].currentState).toBe('loading');
  });

  it('reset clears state and re-initializes', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    const ctx = { outputDir: '/tmp', trait, runtime };
    runtime.dispatch('BrowseItemBrowse', 'BrowseItemLoaded', {});
    expect(runtime.getState('BrowseItemBrowse')).toBe('browsing');
    await driver.reset(ctx);
    expect(runtime.getState('BrowseItemBrowse')).toBe('loading');
  });
});
