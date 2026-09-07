/**
 * R-PERSIST-NO-ROW-KEY-SILENT-SUCCESS remedy (docs/Almadar_Runtime_Gaps.md
 * §R-PERSIST-NO-ROW-KEY-SILENT-SUCCESS).
 *
 * The hermetic walk resets the page (and the mock store) before every
 * step, then replays back to the next step's `from` state via a fewest-
 * hops BFS that dispatches each hop with a SYNTHESIZED (fake) payload —
 * including hops that bind `@entity.id` from the payload. A `persist
 * update|delete` step firing after such a hop resolves against a row key
 * that was never real, and silently no-ops.
 *
 * `TicketEditor` mirrors the shape: `EDIT` (browsing->editing) sets
 * `@entity.id` from `@payload.id`; `SAVE` (editing->browsing) persists
 * the whole bound `@entity`. `SAVE`'s precondition walk traverses EDIT as
 * a real reconcile hop — proving the fix requires that hop's DISPATCHED
 * payload actually carry a real seeded row's id, not a synthesized one.
 */

import { describe, it, expect } from 'vitest';
import type { EntityRow, OrbitalSchema, Trait } from '@almadar/core';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';

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

// R-DATAMUTATION-CREATE-SEED-COLLISION: a hand-authored `[lifecycle,
// instance]` shape (Project Friday's 21 orbitals) where the id-binding
// transition IS the create itself: `(set @entity.id ?id) (persist create
// X @entity)`, sibling to an update-kind transition in the SAME trait
// (so the trait-level `idSeedRow` fetch — gated on "has some non-create
// persist" — fires). `collectEntityIdBindingTransitions` doesn't
// discriminate persist kind, so before the fix `seedEntityIdIfBinding`
// patched the CREATE step's own payload id to the pre-existing seeded
// row's id — indistinguishable from selecting an existing row instead of
// minting a new one.
const lifecycleCreateSharesIdBinding: Trait = {
  name: 'TicketLifecycle',
  scope: 'instance',
  linkedEntity: 'Ticket',
  stateMachine: {
    states: [{ name: 'idle', isInitial: true }, { name: 'open' }],
    events: [
      { key: 'INIT', name: 'Init' },
      { key: 'OPEN', name: 'Open', payloadSchema: [{ name: 'id', type: 'string', required: true }] },
      { key: 'ACCRUE', name: 'Accrue', payloadSchema: [{ name: 'amount', type: 'number', required: true }] },
    ],
    transitions: [
      { from: 'idle', to: 'idle', event: 'INIT' },
      {
        from: 'idle',
        to: 'open',
        event: 'OPEN',
        effects: [
          ['set', '@entity.id', '@payload.id'],
          ['persist', 'create', 'Ticket', '@entity'],
        ],
      },
      {
        from: 'open',
        to: 'open',
        event: 'ACCRUE',
        effects: [['persist', 'update', 'Ticket', '@entity', { emit: { success: 'ACCRUED' } }]],
      },
    ],
  },
};

const editorWithoutBinding: Trait = {
  ...editorWithBinding,
  name: 'TicketEditorUnbound',
  stateMachine: {
    ...editorWithBinding.stateMachine!,
    transitions: [
      { from: 'browsing', to: 'browsing', event: 'INIT' },
      // Same shape, but EDIT never sets @entity.id anywhere in the trait —
      // the ORB_BINDING_PERSIST_ROW_ID_NEVER_SET condition.
      { from: 'browsing', to: 'editing', event: 'EDIT' },
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
    name: 'ticket-editor-fixture',
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

describe('runVerification — persist-write id seeding', () => {
  it('seeds a real row id into the id-binding reconcile hop when the trait can legitimately bind one', async () => {
    const orbital = orbitalFor(editorWithBinding);
    const traits = (await import('../../planner/extract-trait-walk-configs.js')).extractTraitWalkConfigs(orbital);
    const { driver, runtime } = createFakeDriver(traits);

    // FakeRuntime.reset() clears entities; re-seed after every hermetic
    // reset, exactly like the real driver's `bridge.reset` re-seeding the
    // playground's mock persistence store deterministically.
    const originalReset = driver.reset.bind(driver);
    driver.reset = async (ctx) => {
      await originalReset(ctx);
      runtime.seed('Ticket', [SEEDED_ROW]);
    };

    const result = await runVerification({
      itemName: 'ticket-editor-fixture',
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

  it('does NOT seed when the trait has no id-binding transition anywhere — the real corpus defect keeps failing', async () => {
    const orbital = orbitalFor(editorWithoutBinding);
    const traits = (await import('../../planner/extract-trait-walk-configs.js')).extractTraitWalkConfigs(orbital);
    const { driver, runtime } = createFakeDriver(traits);

    const originalReset = driver.reset.bind(driver);
    driver.reset = async (ctx) => {
      await originalReset(ctx);
      runtime.seed('Ticket', [SEEDED_ROW]);
    };

    const result = await runVerification({
      itemName: 'ticket-editor-fixture-unbound',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: baseOptions,
    });

    const editHop = result.frames.find((f) => f.cause.event === 'EDIT' && f.cause.triggerKind === 'reconcile');
    expect(editHop).toBeDefined();
    // No binding transition anywhere in the trait — the real seeded id
    // must never appear on a hop the pipeline can't attribute to a real
    // binding effect.
    expect(editHop?.payload.id).not.toBe(SEEDED_ROW.id);
  });

  it('R-DATAMUTATION-CREATE-SEED-COLLISION: never overwrites a persist-CREATE step\'s own dispatch id with a pre-existing seeded row, even though the create transition is also this trait\'s id-binding one', async () => {
    const orbital = orbitalFor(lifecycleCreateSharesIdBinding);
    const traits = (await import('../../planner/extract-trait-walk-configs.js')).extractTraitWalkConfigs(orbital);
    const { driver, runtime } = createFakeDriver(traits);

    const originalReset = driver.reset.bind(driver);
    driver.reset = async (ctx) => {
      await originalReset(ctx);
      runtime.seed('Ticket', [SEEDED_ROW]);
    };

    const result = await runVerification({
      itemName: 'ticket-lifecycle-create-fixture',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: baseOptions,
    });

    const openFrame = result.frames.find(
      (f) => f.cause.event === 'OPEN' && f.cause.testKind === 'data-mutation',
    );
    expect(openFrame).toBeDefined();
    expect(openFrame?.cause.expectedRowDelta).toEqual({ entityName: 'Ticket', delta: 1 });
    // The planner's own synthesized id (never the pre-existing seeded
    // row's) — a create dispatched with an EXISTING row's id is
    // indistinguishable from selecting it, not minting a new one.
    expect(openFrame?.payload.id).not.toBe(SEEDED_ROW.id);
  });
});
