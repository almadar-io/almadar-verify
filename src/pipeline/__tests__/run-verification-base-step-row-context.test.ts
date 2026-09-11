/**
 * RV item 25/27 — `planWalk`'s base "dispatch every declared transition
 * once" step gets the SAME `viewerRequirement`/row-establishing context
 * `planDataMutationTests`'s sibling step already derives for the identical
 * `(from, event, to)`, instead of dispatching a role-policed persist under
 * no viewer at all (denied by construction, a spurious finding on a
 * transition the data-mutation step already proves works).
 */
import { describe, it, expect } from 'vitest';
import type { EffectTrace, OrbitalSchema, Trait } from '@almadar/core';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';

function roleOnlyPersistOrbital(): OrbitalSchema {
  const persistor: Trait = {
    name: 'RecordPersistor',
    scope: 'instance',
    linkedEntity: 'Record',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [
        { key: 'INIT', name: 'Init' },
        { key: 'DO_CREATE', name: 'Do Create', payloadSchema: [{ name: 'data', type: 'object' }] },
      ],
      transitions: [
        { from: 'idle', to: 'idle', event: 'INIT' },
        {
          from: 'idle',
          to: 'idle',
          event: 'DO_CREATE',
          effects: [['persist', 'create', 'Record', '@payload.data', { emit: { success: 'RECORD_CREATED' } }]],
        },
      ],
    },
  };

  return {
    name: 'base-step-row-context-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'RecordOrbital',
        entity: {
          name: 'Record',
          persistence: 'persistent',
          fields: [{ name: 'id', type: 'string', required: true }],
          create_policy: ['=', '@user.role', 'approver'],
        },
        auxiliaryEntities: [
          {
            name: 'Employee',
            persistence: 'persistent',
            identity: true,
            fields: [
              { name: 'id', type: 'string', required: true },
              { name: 'role', type: 'string', values: ['employee', 'approver'] },
            ],
          },
        ],
        pages: [{ name: 'RecordsPage', path: '/records', traits: [{ ref: 'RecordPersistor' }] }],
        traits: [persistor],
      },
    ],
  };
}

const baseOptions = {
  enableInteractionTests: false,
  enableContractEvents: false,
  enableDataMutationTests: true,
  enableClickPathSamples: false,
  enablePortalPerStep: false,
  enableUserCrudFlow: false,
  enableTickTests: false,
  enableEmitSweep: false,
  log: () => {},
};

describe('runVerification — base-walk step inherits data-mutation row/viewer context (RV item 25/27)', () => {
  it('the base success-variant step for a policed persist dispatches under the SAME derived role, not the default (denied) viewer', async () => {
    const orbital = roleOnlyPersistOrbital();
    const { extractTraitWalkConfigs } = await import('../../planner/extract-trait-walk-configs.js');
    const traits = extractTraitWalkConfigs(orbital);

    // Default viewer carries NO role at all — a role-only policy denies it
    // unless the derived viewerRequirement switches personas first.
    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (effects, { persona }) => {
        const traces: EffectTrace[] = [];
        for (const effect of effects) {
          if (!Array.isArray(effect) || effect[0] !== 'persist' || effect[1] !== 'create') continue;
          const allowed = persona?.['role'] === 'approver';
          traces.push({
            type: 'persist', entityName: 'Record', action: 'create', args: [],
            status: allowed ? 'executed' : 'failed',
            outcome: allowed ? 'success' : 'denied',
            ...(allowed && { resultId: 'record-1' }),
            ...(!allowed && { error: 'denied by access policy (Record create)' }),
          });
        }
        return { effects: traces, emitted: [] };
      },
    });

    const result = await runVerification({
      itemName: 'base-step-row-context-fixture',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: baseOptions,
    });

    const baseStepFrame = result.frames.find(
      (f) => f.cause.event === 'DO_CREATE' && f.cause.payloadCase === 'success' && f.cause.testKind === undefined,
    );
    expect(baseStepFrame).toBeDefined();
    const persistTrace = baseStepFrame?.effectResults.find((e) => e.type === 'persist');
    expect(persistTrace?.outcome).toBe('success');

    const dataMutationFrame = result.frames.find(
      (f) => f.cause.event === 'DO_CREATE' && f.cause.testKind === 'data-mutation',
    );
    expect(dataMutationFrame).toBeDefined();
    expect(dataMutationFrame?.effectResults.find((e) => e.type === 'persist')?.outcome).toBe('success');
  });
});
