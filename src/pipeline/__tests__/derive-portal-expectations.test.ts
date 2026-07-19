import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, Trait } from '@almadar/core';
import { derivePortalExpectations } from '../run-verification.js';

// Fixtures intentionally exercise the schema drift: core types
// `State.onEntry` as `string[]` (effect names), but compiled output may
// carry inline S-expr effects. The single `as Trait` cast here mirrors
// the defensive-scanner style in `planner/internal/effect-emits.ts`.
function orbitalWithTrait(trait: unknown): OrbitalSchema {
  return {
    name: 'fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'FixtureOrbital',
        entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
        pages: [],
        traits: [trait as Trait],
      },
    ],
  };
}

describe('derivePortalExpectations', () => {
  it('scans transition effects (existing behavior)', () => {
    const orbital = orbitalWithTrait({
      name: 'Browse',
      scope: 'collection',
      stateMachine: {
        states: [{ name: 'browsing', isInitial: true }],
        events: [{ key: 'INIT', name: 'Init' }],
        transitions: [
          {
            from: 'browsing', to: 'browsing', event: 'INIT',
            effects: [['render-ui', 'main', { type: 'data-grid' }]],
          },
        ],
      },
    });
    const expectations = derivePortalExpectations(orbital);
    expect(expectations).toEqual([
      { traitName: 'Browse', from: 'browsing', event: 'INIT', to: 'browsing', slot: 'main', pattern: 'data-grid' },
    ]);
  });

  it('scans states[].onEntry and keys the expectation to every transition into the state', () => {
    const orbital = orbitalWithTrait({
      name: 'Modal',
      scope: 'instance',
      stateMachine: {
        states: [
          { name: 'closed', isInitial: true },
          // Core types onEntry as string[] (effect names); compiled output
          // may carry inline S-expr effects — array entries are scanned.
          { name: 'open', onEntry: [['render-ui', 'modal', { type: 'modal' }]] },
        ],
        events: [
          { key: 'OPEN', name: 'Open' },
          { key: 'REFRESH', name: 'Refresh' },
        ],
        transitions: [
          { from: 'closed', to: 'open', event: 'OPEN' },
          { from: 'open', to: 'open', event: 'REFRESH' },
          { from: 'open', to: 'closed', event: 'CLOSE' },
        ],
      },
    });
    const expectations = derivePortalExpectations(orbital);
    expect(expectations).toHaveLength(2);
    expect(expectations).toContainEqual(
      { traitName: 'Modal', from: 'closed', event: 'OPEN', to: 'open', slot: 'modal', pattern: 'modal' },
    );
    expect(expectations).toContainEqual(
      { traitName: 'Modal', from: 'open', event: 'REFRESH', to: 'open', slot: 'modal', pattern: 'modal' },
    );
  });

  it('scans trait-level initialEffects keyed to the auto-init cause', () => {
    const orbital = orbitalWithTrait({
      name: 'Shell',
      scope: 'instance',
      initialEffects: [['render-ui', 'main', { type: 'app-shell' }]],
      stateMachine: {
        states: [{ name: 'ready', isInitial: true }],
        events: [{ key: 'INIT', name: 'Init' }],
        transitions: [{ from: 'ready', to: 'ready', event: 'INIT' }],
      },
    });
    const expectations = derivePortalExpectations(orbital);
    expect(expectations).toEqual([
      { traitName: 'Shell', from: 'ready', event: 'INIT', to: 'ready', slot: 'main', pattern: 'app-shell' },
    ]);
  });

  it('treats a reactive-binding render-ui type as UNKNOWN (skips, never "slot cleared")', () => {
    const orbital = orbitalWithTrait({
      name: 'Bound',
      scope: 'instance',
      stateMachine: {
        states: [{ name: 'ready', isInitial: true }],
        events: [{ key: 'INIT', name: 'Init' }],
        transitions: [
          {
            from: 'ready', to: 'ready', event: 'INIT',
            effects: [['render-ui', 'main', { type: '@config.layout' }]],
          },
        ],
      },
      initialEffects: [['render-ui', 'header', { type: ['object/get', '@config.header', 'type'] }]],
    });
    // Both render sites have non-literal `type` — no expectations at all.
    // Pre-fix these became pattern:null, which asserts the slot is EMPTY
    // (the inverted-semantics bug).
    expect(derivePortalExpectations(orbital)).toEqual([]);
  });

  it('keeps the explicit-clear case (no payload type) as pattern:null', () => {
    const orbital = orbitalWithTrait({
      name: 'Clear',
      scope: 'instance',
      stateMachine: {
        states: [{ name: 'a', isInitial: true }, { name: 'b' }],
        events: [{ key: 'GO', name: 'Go' }],
        transitions: [
          { from: 'a', to: 'b', event: 'GO', effects: [['render-ui', 'modal', null]] },
        ],
      },
    });
    expect(derivePortalExpectations(orbital)).toEqual([
      { traitName: 'Clear', from: 'a', event: 'GO', to: 'b', slot: 'modal', pattern: null },
    ]);
  });

  it('skips bare-string onEntry effect names (not resolvable inline)', () => {
    const orbital = orbitalWithTrait({
      name: 'Named',
      scope: 'instance',
      stateMachine: {
        states: [{ name: 'a', isInitial: true, onEntry: ['renderMain'] }],
        events: [{ key: 'INIT', name: 'Init' }],
        transitions: [{ from: 'a', to: 'a', event: 'INIT' }],
      },
    });
    expect(derivePortalExpectations(orbital)).toEqual([]);
  });
});
