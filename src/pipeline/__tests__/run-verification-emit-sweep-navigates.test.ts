/**
 * R-EMIT-SWEEP-NAVIGATES-NOT-STAMPED (std-notes B4-V2 regression).
 *
 * NoteSubpages-shaped fixture: `Subpages` declares `emits {
 * SELECT_RELATED }`, and `SELECT_RELATED` is only ever DELIVERED by a
 * listener (`BacklinksRouter`) whose triggered arm navigates —
 * `Subpages` itself never does. `runVerification`'s emit-sweep re-fires
 * `SELECT_RELATED` via the bus (on top of whatever click-path/topology
 * steps already exercised it); by the time this step dispatches,
 * `Subpages` is genuinely unmounted (simulated here by leaving it out of
 * the FakeDriver's own trait registry, so `getState('Subpages')` reads
 * `null` — the fake driver's stand-in for "the page navigated away").
 *
 * Before the fix, `planEmitSweep`'s step never carried `navigates`
 * (`extract-trait-walk-configs.ts` / `dispatchNavigates` compute it, but
 * `plan-emit-sweep.ts` never consulted it), so `tick`'s fail-closed gate
 * mis-reported the legitimate null read as `stateless dispatch`. This
 * test proves the wiring end-to-end: `runVerification` threads the
 * schema + the trait's owning `Orbital` into `planEmitSweep`, which
 * stamps `navigates: true`, so the frame carries no error.
 */

import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';
import { extractTraitWalkConfigs } from '../../planner/extract-trait-walk-configs.js';

const schema: OrbitalSchema = {
  name: 'std-notes-fixture',
  designTokens: {},
  customPatterns: {},
  orbitals: [
    {
      name: 'NoteOrbital',
      entity: {
        name: 'Note',
        persistence: 'runtime',
        fields: [{ name: 'id', type: 'string', required: true }],
      },
      pages: [
        { name: 'NoteDetailPage', path: '/notes/:id', traits: [{ ref: 'Subpages' }, { ref: 'BacklinksRouter' }] },
      ],
      traits: [
        {
          name: 'Subpages',
          scope: 'instance',
          linkedEntity: 'Note',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [{ key: 'SELECT_RELATED', name: 'SelectRelated' }],
            transitions: [
              { from: 'idle', to: 'idle', event: 'SELECT_RELATED', effects: [['emit', 'SELECT_RELATED', {}]] },
            ],
          },
          emits: [{ event: 'SELECT_RELATED', scope: 'external' }],
        },
        {
          name: 'BacklinksRouter',
          scope: 'instance',
          linkedEntity: 'Note',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [{ key: 'SELECT', name: 'Select' }],
            transitions: [
              { from: 'idle', to: 'idle', event: 'SELECT', effects: [['navigate', '/notes/related']] },
            ],
          },
          listens: [
            {
              event: 'SELECT_RELATED',
              triggers: 'SELECT',
              scope: 'external',
              source: { kind: 'trait', trait: 'Subpages' },
            },
          ],
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
  log: () => {},
} as const;

describe('runVerification — emit-sweep navigates wiring', () => {
  it('stamps navigates on a listener-cascade emit-sweep step so a legitimate unmount is not misreported', async () => {
    const traits = extractTraitWalkConfigs(schema);
    // Register only `BacklinksRouter` with the FakeDriver — `Subpages` is
    // absent, so `getState('Subpages')` returns null, standing in for the
    // real driver's "the click-path step already navigated the page away"
    // case this bug class is about.
    const { driver, runtime } = createFakeDriver(traits.filter((t) => t.traitName === 'BacklinksRouter'));
    const ctx = { outputDir: '', runtime };

    const result = await runVerification({
      itemName: 'std-notes-fixture',
      orbital: schema,
      driver,
      ctx,
      options: { ...quietOptions, enableEmitSweep: true },
    });

    const emitFrame = result.frames.find(
      (f) => f.cause.traitName === 'Subpages' && f.cause.coverageKey?.endsWith('[emit]'),
    );
    expect(emitFrame).toBeDefined();
    expect(emitFrame?.stateAfter).toBeNull();
    expect(emitFrame?.errors ?? []).toEqual([]);
  });
});
