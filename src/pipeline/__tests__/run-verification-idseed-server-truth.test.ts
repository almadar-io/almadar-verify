/**
 * C1-V14 (F3) — `idSeedRow` is browser-subset truth.
 *
 * `runVerification` fetches the seed row for `seedEntityIdIfBinding` from
 * the driver's snapshot (`entityData`) — the page's visible rows. A page
 * showing NO rows of the linked entity yields `idSeedRow = null`, so the
 * reconcile hop that binds `@entity.id` from `@payload.<path>` keeps a
 * SYNTHESIZED id instead of a real one, and the dependent persist
 * `update`/`delete` step fails with "not found".
 *
 * Fix: source `idSeedRow` from `driver.listEntityRows` (server truth) when
 * the driver has it, falling back to the snapshot exactly as before when
 * it doesn't (or throws).
 */

import { describe, it, expect } from 'vitest';
import type { EntityRow, OrbitalSchema, Trait } from '@almadar/core';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';
import { extractTraitWalkConfigs } from '../../planner/extract-trait-walk-configs.js';

const SEEDED_ROW: EntityRow = { id: 'ticket-seed-1', title: 'Real seeded ticket' };

const editorWithBinding: Trait = {
  name: 'TicketEditor',
  scope: 'collection',
  linkedEntity: 'Ticket',
  stateMachine: {
    states: [{ name: 'browsing', isInitial: true }, { name: 'editing' }],
    events: [
      { key: 'INIT', name: 'Init' },
      { key: 'EDIT', name: 'Edit', payloadSchema: [{ name: 'id', type: 'string', required: true }] },
      { key: 'SAVE', name: 'Save' },
    ],
    transitions: [
      { from: 'browsing', to: 'browsing', event: 'INIT' },
      {
        from: 'browsing',
        to: 'editing',
        event: 'EDIT',
        effects: [['set', '@entity.id', '@payload.id']],
      },
      {
        from: 'editing',
        to: 'browsing',
        event: 'SAVE',
        effects: [['persist', 'update', 'Ticket', '@entity', { emit: { success: 'SAVED' } }]],
      },
    ],
  },
};

function orbitalFor(trait: Trait): OrbitalSchema {
  return {
    name: 'ticket-editor-server-truth-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'TicketOrbital',
        entity: {
          name: 'Ticket',
          persistence: 'runtime',
          fields: [
            { name: 'id', type: 'string', required: true },
            { name: 'title', type: 'string' },
          ],
        },
        pages: [{ name: 'TicketPage', path: '/tickets', traits: [{ ref: trait.name }] }],
        traits: [trait],
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

describe('runVerification — idSeedRow server-truth sourcing (C1-V14, F3)', () => {
  it('seeds from listEntityRows (server truth) when the snapshot shows zero visible rows of the linked entity', async () => {
    const orbital = orbitalFor(editorWithBinding);
    const traits = extractTraitWalkConfigs(orbital);
    const { driver, runtime } = createFakeDriver(traits);

    const originalReset = driver.reset.bind(driver);
    driver.reset = async (ctx) => {
      await originalReset(ctx);
      runtime.seed('Ticket', [SEEDED_ROW]);
    };

    // The page renders NOTHING of the linked entity — `snapshot().entityData`
    // reports zero Ticket rows — but the server-truth store (`listEntityRows`,
    // reading straight off `runtime`) still has the seeded row.
    const originalSnapshot = driver.snapshot.bind(driver);
    driver.snapshot = async (ctx, step) => {
      const snap = await originalSnapshot(ctx, step);
      return { ...snap, entityData: { ...snap.entityData, Ticket: [] } };
    };

    const result = await runVerification({
      itemName: 'ticket-editor-server-truth-fixture',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: baseOptions,
    });

    const editHop = result.frames.find((f) => f.cause.event === 'EDIT' && f.cause.triggerKind === 'reconcile');
    expect(editHop).toBeDefined();
    // Sourced from `listEntityRows` (server truth), not the zeroed-out
    // browser snapshot — a real row id, not a synthesized one.
    expect(editHop?.payload.id).toBe(SEEDED_ROW.id);

    const saveFrame = result.frames.find((f) => f.cause.event === 'SAVE');
    expect(saveFrame).toBeDefined();
    expect(saveFrame?.accepted).toBe(true);
  });

  it('falls back to the snapshot exactly as before when the driver has no listEntityRows', async () => {
    const orbital = orbitalFor(editorWithBinding);
    const traits = extractTraitWalkConfigs(orbital);
    const { driver, runtime } = createFakeDriver(traits);

    const originalReset = driver.reset.bind(driver);
    driver.reset = async (ctx) => {
      await originalReset(ctx);
      runtime.seed('Ticket', [SEEDED_ROW]);
    };
    // Simulate a driver that can't answer the server-truth query.
    driver.listEntityRows = undefined;

    const result = await runVerification({
      itemName: 'ticket-editor-server-truth-fixture-no-list',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: baseOptions,
    });

    const editHop = result.frames.find((f) => f.cause.event === 'EDIT' && f.cause.triggerKind === 'reconcile');
    expect(editHop).toBeDefined();
    expect(editHop?.payload.id).toBe(SEEDED_ROW.id);

    const saveFrame = result.frames.find((f) => f.cause.event === 'SAVE');
    expect(saveFrame).toBeDefined();
    expect(saveFrame?.accepted).toBe(true);
  });
});
