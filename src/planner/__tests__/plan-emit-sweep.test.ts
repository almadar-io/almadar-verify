import { describe, it, expect } from 'vitest';
import type { Effect, Orbital, OrbitalSchema } from '@almadar/core';
import { planEmitSweep } from '../plan-emit-sweep.js';
import type { TraitWalkConfig } from '../../engine/types.js';
import type { EmitDeclaration } from '../../browser/catalog-probes.js';

const trait: TraitWalkConfig = {
  traitName: 'BrowseItemBrowse',
  initialState: 'loading',
  transitions: [],
};

describe('planEmitSweep', () => {
  it('emits one bus step per declared success event', () => {
    const emits: EmitDeclaration[] = [
      { success: 'BrowseItemLoaded' },
      { success: 'OtherEvent' },
    ];
    const steps = planEmitSweep({ trait, emits });
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step.triggerKind).toBe('bus');
      expect(step.from).toBe('loading');
      expect(step.to).toBe('loading');
      expect(step.coverageKey).toMatch(/\[emit\]$/);
    }
    const events = steps.map((s) => s.event).sort();
    expect(events).toEqual(['BrowseItemLoaded', 'OtherEvent']);
  });

  it('emits one step for each of success and failure when both are declared', () => {
    const emits: EmitDeclaration[] = [
      { success: 'BrowseItemLoaded', failure: 'BrowseItemLoadFailed' },
    ];
    const steps = planEmitSweep({ trait, emits });
    expect(steps).toHaveLength(2);
    const events = steps.map((s) => s.event).sort();
    expect(events).toEqual(['BrowseItemLoadFailed', 'BrowseItemLoaded']);
  });

  it('deduplicates repeated event names across declarations', () => {
    const emits: EmitDeclaration[] = [
      { success: 'X' },
      { success: 'X' },
      { failure: 'X' },
    ];
    const steps = planEmitSweep({ trait, emits });
    expect(steps).toHaveLength(1);
    expect(steps[0].event).toBe('X');
  });

  it('returns [] for an empty emits list', () => {
    expect(planEmitSweep({ trait, emits: [] })).toHaveLength(0);
  });

  it('uses [emit]-suffixed coverage keys to distinguish from topology coverage', () => {
    const emits: EmitDeclaration[] = [{ success: 'PingEvent' }];
    const [step] = planEmitSweep({ trait, emits });
    expect(step.coverageKey).toBe(
      'BrowseItemBrowse:loading+PingEvent->loading[emit]',
    );
  });

  it('omits navigates when schema/orb are not provided (pre-existing behavior)', () => {
    const emits: EmitDeclaration[] = [{ success: 'PingEvent' }];
    const [step] = planEmitSweep({ trait, emits });
    expect(step.navigates).toBeUndefined();
  });

  // R-EMIT-SWEEP-NAVIGATES-NOT-STAMPED: NoteDetailLayout/NoteSubpages-shaped
  // regression (std-notes). Both traits are frontier/imported composed
  // atoms whose `emits { BACK }` / `(emit SELECT_RELATED ...)` contract
  // ALSO gets independently re-dispatched by this planner via the bus (on
  // top of the click-path step that already exercises the same event).
  // The event genuinely navigates — either the trait's own transition from
  // its initial state carries `navigate`/`navigate-back` (BACK), or only a
  // LISTENER's triggered arm does (SELECT_RELATED, `NoteBacklinksRouter
  // listens NoteSubpages.SELECT_RELATED -> SELECT_RELATED`). Before this
  // fix `makeEmitStep` never stamped `navigates`, so `tick`'s post-dispatch
  // null-state read (legitimate — the earlier click-path step already
  // navigated the trait's page away) misreported as `stateless dispatch`.
  describe('navigates (dispatchNavigates oracle)', () => {
    function orbitalWithListenerCascade(listenerEffects: Effect[]): { schema: OrbitalSchema; orb: Orbital } {
      const orb: Orbital = {
        name: 'NoteOrbital',
        entity: { name: 'Note', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
        traits: [
          {
            name: 'Subpages',
            scope: 'instance',
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
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'SELECT', name: 'Select' }],
              transitions: [{ from: 'idle', to: 'idle', event: 'SELECT', effects: listenerEffects }],
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
        pages: [],
      };
      const schema: OrbitalSchema = { name: 'NoteApp', designTokens: {}, customPatterns: {}, orbitals: [orb] };
      return { schema, orb };
    }

    it('stamps navigates: true when only a LISTENER\'s triggered arm navigates (SELECT_RELATED-shaped)', () => {
      const { schema, orb } = orbitalWithListenerCascade([['navigate', '/notes/related']]);
      const subpages: TraitWalkConfig = { traitName: 'Subpages', initialState: 'idle', transitions: [] };
      const [step] = planEmitSweep({
        trait: subpages,
        emits: [{ success: 'SELECT_RELATED' }],
        schema,
        orb,
      });
      expect(step.navigates).toBe(true);
    });

    it('does not stamp navigates when neither the trait nor its listener navigates', () => {
      const { schema, orb } = orbitalWithListenerCascade([['set', '@entity.selected', '@payload.key']]);
      const subpages: TraitWalkConfig = { traitName: 'Subpages', initialState: 'idle', transitions: [] };
      const [step] = planEmitSweep({
        trait: subpages,
        emits: [{ success: 'SELECT_RELATED' }],
        schema,
        orb,
      });
      expect(step.navigates).toBeUndefined();
    });

    it('stamps navigates: true when the swept trait\'s own initial-state transition navigates (BACK-shaped)', () => {
      const orb: Orbital = {
        name: 'NoteOrbital',
        entity: { name: 'Note', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
        traits: [
          {
            name: 'NoteDetailLayout',
            scope: 'instance',
            stateMachine: {
              states: [{ name: 'composing', isInitial: true }],
              events: [{ key: 'BACK', name: 'Back' }],
              transitions: [
                { from: 'composing', to: 'composing', event: 'BACK', effects: [['navigate-back']] },
              ],
            },
            emits: [{ event: 'BACK', scope: 'external' }],
          },
        ],
        pages: [],
      };
      const schema: OrbitalSchema = { name: 'NoteApp', designTokens: {}, customPatterns: {}, orbitals: [orb] };
      const detailLayout: TraitWalkConfig = { traitName: 'NoteDetailLayout', initialState: 'composing', transitions: [] };
      const [step] = planEmitSweep({
        trait: detailLayout,
        emits: [{ success: 'BACK' }],
        schema,
        orb,
      });
      expect(step.navigates).toBe(true);
    });
  });

  it("sweeps an event with its declared payload filled, so the server's validator accepts it (G-VERIFY-042)", () => {
    const withSchema: TraitWalkConfig = {
      ...trait,
      events: [
        { key: 'ReviewLogged', name: 'ReviewLogged', payloadSchema: [{ name: 'id', type: 'string', required: true }, { name: 'round', type: 'number' }] },
        { key: 'SyncFailed', name: 'SyncFailed', payloadSchema: [{ name: 'error', type: 'string', required: true }] },
      ],
    };
    const steps = planEmitSweep({ trait: withSchema, emits: [{ success: 'ReviewLogged', failure: 'SyncFailed' }] });
    const logged = steps.find((s) => s.event === 'ReviewLogged');
    const failed = steps.find((s) => s.event === 'SyncFailed');
    expect(typeof logged?.payload.id).toBe('string');
    expect(String(logged?.payload.id).length).toBeGreaterThan(0);
    expect(typeof failed?.payload.error).toBe('string');
  });

  it('control: an event with no declared payload is swept with {}', () => {
    const [step] = planEmitSweep({ trait, emits: [{ success: 'PingEvent' }] });
    expect(step.payload).toEqual({});
  });
});
