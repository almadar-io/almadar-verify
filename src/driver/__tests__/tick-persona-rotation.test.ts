/**
 * A step a persona's access policy refuses is walked as every roster persona until one is admitted (G-ORBITAL-SHELL-
 * TYPESCRIPT-026, ruled 2026-10-18): the step is covered when a permitted persona runs it, and the refusal of a persona the
 * policy excludes is expected, never a finding. The app's own default persona is restored afterwards.
 */
import { describe, it, expect } from 'vitest';
import type { EdgeWalkTransition, EffectTrace, RawUserClaims } from '@almadar/core';
import { tick } from '../tick.js';
import { createFakeDriver, type FakeDriverContext } from '../impls/fake.js';
import type { Driver, SendResult, SnapshotResult } from '../types.js';
import type { TraitWalkConfig } from '../../engine/types.js';
import type { ExtendedWalkStep } from '../../planner/types.js';

const transition = (from: string, event: string, to: string): EdgeWalkTransition => ({ from, event, to, hasGuard: false });

const trait: TraitWalkConfig = {
  traitName: 'ContactDelete',
  initialState: 'idle',
  transitions: [transition('idle', 'INIT', 'idle'), transition('idle', 'CONFIRM_DELETE', 'done')],
};

const step = (from: string, event: string, to: string, triggerKind: ExtendedWalkStep['triggerKind'] = 'bus'): ExtendedWalkStep => ({
  from, event, to, guardCase: null, payload: {}, isRepositioning: false, traitName: trait.traitName, triggerKind,
  coverageKey: `${trait.traitName}:${from}+${event}->${to}`,
});

const owner: RawUserClaims = { id: 'TeamMember Id 1', role: 'owner' };
const admin: RawUserClaims = { id: 'TeamMember Id 2', role: 'admin' };
const viewer: RawUserClaims = { id: 'TeamMember Id 3', role: 'viewer' };

const denial: EffectTrace = { type: 'persist', action: 'delete', entityName: 'Contact', outcome: 'denied', args: [], status: 'failed' };

/** A driver whose `CONFIRM_DELETE` is admitted only for the personas in `admitted`. */
function policedDriver(admitted: ReadonlySet<string>, opts: { roster?: boolean } = {}) {
  const { driver, runtime } = createFakeDriver([trait]);
  let current: RawUserClaims | null = owner;
  const sentAs: Array<string | null> = [];
  let lastDenied = false;
  const policed: Driver<FakeDriverContext> = {
    ...driver,
    async sendEvent(c, event, payload, scope): Promise<SendResult> {
      if (event !== 'CONFIRM_DELETE') return driver.sendEvent(c, event, payload, scope);
      sentAs.push(current?.id ?? null);
      lastDenied = !admitted.has(current?.id ?? '');
      if (lastDenied) return { sent: true, serverResponse: null };
      return driver.sendEvent(c, event, payload, scope);
    },
    async snapshot(c, s): Promise<SnapshotResult> {
      const snap = await driver.snapshot(c, s);
      return s?.event === 'CONFIRM_DELETE' && lastDenied ? { ...snap, effectResults: [denial] } : snap;
    },
    async getPersona() {
      return current;
    },
    async setPersona(_c, persona) {
      current = persona;
    },
    ...(opts.roster === false ? {} : { listPersonas: async () => [owner, admin, viewer] }),
  };
  return { driver: policed, ctx: { outputDir: '/tmp', trait, runtime } satisfies FakeDriverContext, sentAs, persona: () => current };
}

describe('tick — persona rotation on an access denial', () => {
  it('walks a refused step as the next persona the policy admits, and restores the default persona', async () => {
    const { driver, ctx, sentAs, persona } = policedDriver(new Set([admin.id!]));
    const init = await tick(driver, ctx, null, step('idle', 'INIT', 'idle', 'auto-init'), undefined, undefined, owner);
    const frame = await tick(driver, ctx, init, step('idle', 'CONFIRM_DELETE', 'done'), undefined, undefined, owner);
    expect(sentAs).toEqual([owner.id, admin.id]);
    expect(frame.accepted).toBe(true);
    expect(frame.errors).toEqual([]);
    expect(frame.cause.admittedPersona).toBe(admin.id);
    expect(persona()).toEqual(owner);
  });

  it('control: a step every persona is refused stays refused, tried once per persona', async () => {
    const { driver, ctx, sentAs } = policedDriver(new Set());
    const init = await tick(driver, ctx, null, step('idle', 'INIT', 'idle', 'auto-init'), undefined, undefined, owner);
    const frame = await tick(driver, ctx, init, step('idle', 'CONFIRM_DELETE', 'done'), undefined, undefined, owner);
    expect(sentAs).toEqual([owner.id, admin.id, viewer.id]);
    expect(frame.accepted).toBe(false);
    expect(frame.cause.admittedPersona).toBeUndefined();
  });

  it('edge: a driver that cannot list personas sends once', async () => {
    const { driver, ctx, sentAs } = policedDriver(new Set([admin.id!]), { roster: false });
    const init = await tick(driver, ctx, null, step('idle', 'INIT', 'idle', 'auto-init'), undefined, undefined, owner);
    await tick(driver, ctx, init, step('idle', 'CONFIRM_DELETE', 'done'), undefined, undefined, owner);
    expect(sentAs).toEqual([owner.id]);
  });
});
