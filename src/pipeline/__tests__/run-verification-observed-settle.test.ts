// The precondition check reads where the runtime actually settled after a reset, not the trait's
// declared initial state: a list whose INIT fetch lands it in `browsing` must walk its browsing arms.
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';
import { extractTraitWalkConfigs } from '../../planner/extract-trait-walk-configs.js';

function browseShape(extra: Array<{ from: string; to: string; event: string; guard?: unknown }> = []): OrbitalSchema {
  return {
    name: 'browse-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [{
      name: 'BrowseOrbital',
      entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
      pages: [{ name: 'ItemsPage', path: '/items', traits: [{ ref: 'Browse' }] }],
      traits: [{
        name: 'Browse',
        scope: 'instance',
        linkedEntity: 'Item',
        stateMachine: {
          states: [{ name: 'loading', isInitial: true }, { name: 'browsing' }],
          events: [
            { key: 'INIT', name: 'Init' },
            { key: 'LOADED', name: 'Loaded' },
            { key: 'REFETCH', name: 'Refetch' },
            { key: 'VIEW', name: 'View' },
          ],
          transitions: [
            { from: 'loading', to: 'loading', event: 'INIT', effects: [['fetch', 'Item', { emit: { success: 'LOADED' } }]] },
            { from: 'loading', to: 'browsing', event: 'LOADED' },
            { from: 'browsing', to: 'browsing', event: 'REFETCH' },
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

async function run(landsAfterReset: 'browsing' | 'loading', extra: Parameters<typeof browseShape>[0] = []) {
  const orbital = browseShape(extra);
  const { driver, runtime } = createFakeDriver(extractTraitWalkConfigs(orbital));
  const reset = driver.reset?.bind(driver);
  driver.reset = async (ctx) => {
    await reset?.(ctx);
    runtime.setState('Browse', landsAfterReset);
  };
  return runVerification({ itemName: 'browse-fixture', orbital, driver, ctx: { outputDir: '', runtime }, options });
}

describe('runVerification — observed settle after reset', () => {
  it('a trait the host lands in browsing on boot walks its browsing arm instead of skipping it as transient', async () => {
    const result = await run('browsing');
    expect(result.verdicts.preconditionSkipped?.detail ?? '').not.toContain('Browse:browsing+REFETCH->browsing');
    expect(result.frames.some((f) => f.cause.event === 'REFETCH' && f.stateBefore === 'browsing')).toBe(true);
  });

  it('control: a trait that really rests in loading still skips the browsing-only arm', async () => {
    const result = await run('loading');
    expect(result.verdicts.preconditionSkipped?.detail ?? '').toContain('Browse:browsing+REFETCH->browsing');
  });
});

describe('runVerification — an arm the bound config makes impossible', () => {
  it('a guard folded to a false literal (call-site config) is not counted as uncovered', async () => {
    const result = await run('browsing', [{ from: 'browsing', to: 'browsing', event: 'VIEW', guard: ['=', 'table', 'master-detail'] }]);
    expect(result.coverage.schemaTransitions).toBe(3);
    expect(result.coverage.uncovered).not.toContain('Browse:browsing+VIEW->browsing');
  });

  it('control: the same arm under a config that admits it is still required', async () => {
    const result = await run('browsing', [{ from: 'browsing', to: 'browsing', event: 'VIEW', guard: ['=', 'master-detail', 'master-detail'] }]);
    expect(result.coverage.schemaTransitions).toBe(4);
    expect(result.frames.some((f) => f.cause.event === 'VIEW' && f.accepted)).toBe(true);
  });
});
