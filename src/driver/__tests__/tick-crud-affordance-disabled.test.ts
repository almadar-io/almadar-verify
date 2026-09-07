/**
 * C1-V15 item B: a DOM-driven crud-edit/crud-delete step must target a row
 * whose affordance is actually ENABLED. Mirrors std-helpdesk's `RATE`
 * button — `disabled={(if (and (= ?data.status resolved) (not
 * ?data.csatScore)) false true)}`, enabled only for a resolved, unrated
 * ticket — clicking it while disabled is a structural no-op (DOM ✓,
 * cascade ✗).
 *
 * @packageDocumentation
 */
import { describe, it, expect } from 'vitest';
import type { EdgeWalkTransition, SExpr } from '@almadar/core';
import { tick } from '../tick.js';
import { createFakeDriver } from '../impls/fake.js';
import type { TraitWalkConfig } from '../../engine/types.js';
import type { ExtendedWalkStep } from '../../planner/types.js';

function transition(from: string, event: string, to: string): EdgeWalkTransition {
  return { from, event, to, hasGuard: false };
}

const trait: TraitWalkConfig = {
  traitName: 'TicketCsatSurvey',
  initialState: 'closed',
  transitions: [transition('closed', 'INIT', 'closed'), transition('closed', 'RATE', 'open')],
};

// `(if (and (= @payload.data.status "resolved") (not @payload.data.csatScore)) false true)`
const RATE_DISABLED_EXPR: SExpr = [
  'if',
  ['and', ['=', '@payload.data.status', 'resolved'], ['not', '@payload.data.csatScore']],
  false,
  true,
];

function crudStep(overrides: Partial<ExtendedWalkStep> = {}): ExtendedWalkStep {
  return {
    from: 'closed',
    event: 'RATE',
    to: 'open',
    guardCase: null,
    payload: {},
    isRepositioning: false,
    traitName: trait.traitName,
    triggerKind: 'dom',
    coverageKey: `${trait.traitName}:closed+RATE->open[crud-edit]`,
    testKind: 'crud-edit',
    expectedRowDelta: { entityName: 'Ticket', delta: 0 },
    affordanceDisabledExpr: { expr: RATE_DISABLED_EXPR, bindingRoot: 'payload' },
    ...overrides,
  };
}

describe('tick — crud row resolution excludes disabled affordances (C1-V15 item B)', () => {
  it('targets the resolved/unrated row when a sibling row is open (disabled)', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    const ctx = { outputDir: '/tmp', trait, runtime };
    runtime.seed('Ticket', [
      { id: 'open-ticket', status: 'open', csatScore: null },
      { id: 'resolved-ticket', status: 'resolved', csatScore: null },
    ]);

    const init = await tick(driver, ctx, null, crudStep({ event: 'INIT', to: 'closed', triggerKind: 'auto-init', testKind: undefined, affordanceDisabledExpr: undefined }));
    const frame = await tick(driver, ctx, init, crudStep());

    expect(frame.cause.targetRowId).toBe('resolved-ticket');
    expect(frame.errors ?? []).toEqual([]);
  });

  it('reports no-target-row naming the affordance reason when every row is disabled', async () => {
    const { driver, runtime } = createFakeDriver([trait]);
    const ctx = { outputDir: '/tmp', trait, runtime };
    runtime.seed('Ticket', [
      { id: 't1', status: 'open', csatScore: null },
      { id: 't2', status: 'open', csatScore: null },
    ]);

    const init = await tick(driver, ctx, null, crudStep({ event: 'INIT', to: 'closed', triggerKind: 'auto-init', testKind: undefined, affordanceDisabledExpr: undefined }));
    const frame = await tick(driver, ctx, init, crudStep());

    expect(frame.accepted).toBe(false);
    expect(frame.errors).toHaveLength(1);
    expect(frame.errors[0]).toContain('no-target-row');
    expect(frame.errors[0]).toContain('disabled');
  });
});
