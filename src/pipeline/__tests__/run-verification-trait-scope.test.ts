/**
 * `--trait` scope (`options.traits`) — owner ruling 2026-09-11:
 * verification is one trait at a time. Mirrors `orb verify --trait`
 * (`orbital-rust/crates/orbital-verify/src/planner.rs`): a scoped run
 * dispatches only the named trait(s)' steps, an unknown name errors
 * listing every available trait, and (for the separate cascade probe)
 * a listens route is probed when EITHER end resolves into the scope.
 */

import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '@almadar/runtime/OrbitalServerRuntime';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';
import { extractTraitWalkConfigs } from '../../planner/extract-trait-walk-configs.js';
import { probeListenCascades } from '../../observer/probe-listen-cascades.js';

const twoTraits: OrbitalSchema = {
  name: 'trait-scope-fixture',
  orbitals: [
    {
      name: 'ItemOrbital',
      entity: {
        name: 'Item',
        persistence: 'runtime',
        fields: [{ name: 'id', type: 'string', required: true }],
      },
      pages: [
        { name: 'ItemPage', path: '/items', traits: [{ ref: 'ItemA' }, { ref: 'ItemB' }] },
      ],
      traits: [
        {
          name: 'ItemA',
          scope: 'collection',
          linkedEntity: 'Item',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }, { name: 'active' }],
            events: [{ key: 'INIT', name: 'Initialize' }, { key: 'GO', name: 'Go' }],
            transitions: [
              { from: 'idle', to: 'idle', event: 'INIT' },
              { from: 'idle', to: 'active', event: 'GO' },
            ],
          },
        },
        {
          name: 'ItemB',
          scope: 'collection',
          linkedEntity: 'Item',
          stateMachine: {
            states: [{ name: 'ready', isInitial: true }, { name: 'done' }],
            events: [{ key: 'INIT', name: 'Initialize' }, { key: 'FINISH', name: 'Finish' }],
            transitions: [
              { from: 'ready', to: 'ready', event: 'INIT' },
              { from: 'ready', to: 'done', event: 'FINISH' },
            ],
          },
        },
      ],
    },
  ],
};

const quietOptions = {
  enableInteractionTests: false,
  enableContractEvents: false,
  enableDataMutationTests: false,
  enableClickPathSamples: false,
  enablePortalPerStep: false,
  enableUserCrudFlow: false,
  enableTickTests: false,
  enableEmitSweep: false,
  log: () => {},
} as const;

describe('runVerification — trait scope (options.traits)', () => {
  it('scoped run dispatches only the named trait\'s steps and scopes coverage', async () => {
    const traits = extractTraitWalkConfigs(twoTraits);
    const { driver, runtime } = createFakeDriver(traits);
    const ctx = { outputDir: '', runtime };

    const result = await runVerification({
      itemName: 'trait-scope-fixture',
      orbital: twoTraits,
      driver,
      ctx,
      options: { ...quietOptions, traits: ['ItemA'] },
    });

    expect(result.traits).toEqual(['ItemA']);
    expect(result.frames.every((f) => f.cause.traitName === 'ItemA')).toBe(true);
    expect(result.frames.some((f) => f.cause.traitName === 'ItemB')).toBe(false);
    // Denominator = ItemA's 2 declared transitions only.
    expect(result.coverage.schemaTransitions).toBe(2);
  });

  it('an unscoped run (no traits option) walks both traits, no traits field on the report', async () => {
    const traits = extractTraitWalkConfigs(twoTraits);
    const { driver, runtime } = createFakeDriver(traits);
    const ctx = { outputDir: '', runtime };

    const result = await runVerification({
      itemName: 'trait-scope-fixture',
      orbital: twoTraits,
      driver,
      ctx,
      options: { ...quietOptions },
    });

    expect(result.traits).toBeUndefined();
    expect(result.frames.some((f) => f.cause.traitName === 'ItemA')).toBe(true);
    expect(result.frames.some((f) => f.cause.traitName === 'ItemB')).toBe(true);
    expect(result.coverage.schemaTransitions).toBe(4);
  });

  it('an unknown --trait name errors, listing every available trait', async () => {
    const traits = extractTraitWalkConfigs(twoTraits);
    const { driver, runtime } = createFakeDriver(traits);
    const ctx = { outputDir: '', runtime };

    await expect(
      runVerification({
        itemName: 'trait-scope-fixture',
        orbital: twoTraits,
        driver,
        ctx,
        options: { ...quietOptions, traits: ['NoSuchTrait'] },
      }),
    ).rejects.toThrow(/unknown --trait "NoSuchTrait".*ItemA.*ItemB/s);
  });

  it('combined with walkScope: frontier, frontier.authoredTraits counts the SCOPED set, not the whole schema', async () => {
    const traits = extractTraitWalkConfigs(twoTraits);
    const { driver, runtime } = createFakeDriver(traits);
    const ctx = { outputDir: '', runtime };

    const result = await runVerification({
      itemName: 'trait-scope-fixture',
      orbital: twoTraits,
      driver,
      ctx,
      options: { ...quietOptions, walkScope: 'frontier', traits: ['ItemA'] },
    });

    // Neither trait is sourceBehavior-stamped, so frontier skips nothing —
    // the regression this guards: authoredTraits must reflect the 1-trait
    // `--trait` scope, never the schema's full trait count (2).
    expect(result.frontier?.authoredTraits).toBe(1);
    expect(result.frontier?.importedTraits).toBe(0);
    expect(result.traits).toEqual(['ItemA']);
  });
});

/** Minimal working-cascade fixture (mirrors `probe-listen-cascades.test.ts`'s
 *  own `PingApp`) plus a third, unrelated `Bystander`/`OTHER` pair so a
 *  `--trait` scope naming only one end of the real route can be told apart
 *  from one naming neither. */
function cascadeFixture(): OrbitalSchema {
  return {
    name: 'CascadeScopeApp',
    orbitals: [
      {
        name: 'CascadeOrbital',
        entity: { name: 'Ping', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [
          {
            name: 'Source',
            scope: 'instance',
            linkedEntity: 'Ping',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'FIRE', name: 'Fire' }],
              transitions: [{ from: 'idle', to: 'idle', event: 'FIRE', effects: [['emit', 'PING', {}]] }],
            },
            emits: [{ event: 'PING', scope: 'external' }],
          },
          {
            name: 'Listener',
            scope: 'instance',
            linkedEntity: 'Ping',
            stateMachine: {
              states: [{ name: 'active', isInitial: true }],
              events: [{ key: 'TICK', name: 'Tick' }],
              transitions: [{ from: 'active', to: 'active', event: 'TICK', effects: [['emit', 'RECEIVED', {}]] }],
            },
            emits: [{ event: 'RECEIVED', scope: 'external' }],
            listens: [
              { event: 'PING', triggers: 'TICK', scope: 'external', source: { kind: 'trait', trait: 'Source' } },
            ],
          },
          {
            name: 'Bystander',
            scope: 'instance',
            linkedEntity: 'Ping',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'NOOP', name: 'Noop' }],
              transitions: [{ from: 'idle', to: 'idle', event: 'NOOP' }],
            },
          },
        ],
        pages: [],
      },
    ],
  };
}

describe('probeListenCascades — trait scope (SOURCE or TARGET inclusion)', () => {
  it('an unscoped probe covers the one source-qualified listen', async () => {
    const schema = cascadeFixture();
    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(schema);
    const result = await probeListenCascades(runtime, schema);
    expect(result.probed).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it('scoping to the TARGET (listener) trait still probes the route', async () => {
    const schema = cascadeFixture();
    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(schema);
    const result = await probeListenCascades(runtime, schema, undefined, ['Listener']);
    expect(result.probed).toBe(1);
  });

  it('scoping to the SOURCE trait still probes the route', async () => {
    const schema = cascadeFixture();
    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(schema);
    const result = await probeListenCascades(runtime, schema, undefined, ['Source']);
    expect(result.probed).toBe(1);
  });

  it('scoping to an unrelated trait probes nothing', async () => {
    const schema = cascadeFixture();
    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(schema);
    const result = await probeListenCascades(runtime, schema, undefined, ['Bystander']);
    expect(result.probed).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it('an unknown --trait name errors, listing every available trait', async () => {
    const schema = cascadeFixture();
    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(schema);
    await expect(probeListenCascades(runtime, schema, undefined, ['NoSuchTrait'])).rejects.toThrow(
      /unknown --trait "NoSuchTrait".*Bystander.*Listener.*Source/s,
    );
  });
});
