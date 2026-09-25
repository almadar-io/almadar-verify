// G-VERIFY-043: a step whose `from` is a transient the runtime never rests in is skipped when the live state has no arm for its event, not fired from idle.
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';
import { extractTraitWalkConfigs } from '../../planner/extract-trait-walk-configs.js';

type Arm = { from: string; to: string; event: string; guard?: unknown; effects?: unknown[] };

function calendarShape(extra: Arm[] = []): OrbitalSchema {
  return {
    name: 'std-calendar-sync-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [{
      name: 'SyncOrbital',
      entity: { name: 'SyncRun', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
      pages: [{ name: 'SyncPage', path: '/sync', traits: [{ ref: 'Sync' }] }],
      traits: [{
        name: 'Sync',
        scope: 'instance',
        linkedEntity: 'SyncRun',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }, { name: 'pulling' }],
          events: [
            { key: 'INIT', name: 'Init' },
            { key: 'SYNC_NOW', name: 'Sync' },
            { key: 'LISTED', name: 'Listed' },
            { key: 'FAILED', name: 'Failed' },
            { key: 'PULL_NEXT', name: 'Pull next' },
          ],
          transitions: [
            { from: 'idle', to: 'idle', event: 'INIT' },
            { from: 'idle', to: 'idle', event: 'SYNC_NOW', effects: [['fetch', 'SyncRun', { emit: { success: 'LISTED', failure: 'FAILED' } }]] },
            { from: 'idle', to: 'pulling', event: 'LISTED' },
            { from: 'pulling', to: 'idle', event: 'PULL_NEXT' },
            ...extra,
          ],
        },
      }],
    }],
  } as OrbitalSchema;
}

const options = {
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

async function run(orbital: OrbitalSchema) {
  const { driver, runtime } = createFakeDriver(extractTraitWalkConfigs(orbital));
  // The fetch's LISTED never lands inside the settle window: the trait rests at idle.
  const original = driver.sendEvent.bind(driver);
  driver.sendEvent = async (ctx, event, payload, scope) => {
    const result = await original(ctx, event, payload, scope);
    if (event === 'LISTED') runtime.setState(ctx.trait.traitName, 'idle');
    return result;
  };
  return runVerification({ itemName: 'std-calendar-sync-fixture', orbital, driver, ctx: { outputDir: '', runtime }, options });
}

const pullNextFromIdle = (frames: ReadonlyArray<{ cause: { event: string; triggerKind?: string }; stateBefore: string | null }>) =>
  frames.filter((f) => f.cause.event === 'PULL_NEXT' && f.cause.triggerKind !== 'reconcile' && f.stateBefore === 'idle');

describe('runVerification — transient precondition', () => {
  it('skips PULL_NEXT when the runtime rests at idle, which has no PULL_NEXT arm', async () => {
    const result = await run(calendarShape());
    expect(result.verdicts.preconditionSkipped?.detail).toContain("Sync:pulling+PULL_NEXT->idle — precondition 'pulling' is transient — the runtime settled at 'idle', which has no PULL_NEXT arm");
    expect(pullNextFromIdle(result.frames)).toHaveLength(0);
  });

  it('control: fires PULL_NEXT from idle when idle declares its own PULL_NEXT arm', async () => {
    const result = await run(calendarShape([{ from: 'idle', to: 'idle', event: 'PULL_NEXT' }]));
    expect(result.verdicts.preconditionSkipped?.detail ?? '').not.toContain('pulling+PULL_NEXT');
    expect(pullNextFromIdle(result.frames).length).toBeGreaterThan(0);
  });
});
