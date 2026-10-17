/**
 * Tests for `planWalk` — the centerpiece planner.
 *
 * The std-browse fixture is the gold-standard regression: 3/5 → 5/5
 * coverage when the @almadar/core INIT-filter fix lands. Pinning the
 * exact step set here means any future drift gets caught immediately.
 */

import { describe, it, expect } from 'vitest';
import type { EdgeWalkTransition, OrbitalSchema, Trait } from '@almadar/core';
import { planWalk } from '../plan-walk.js';
import { conformGuardPayload } from '../internal/payload-synth.js';
import type { TraitWalkConfig } from '../../engine/types.js';
import type { EntityFieldDef } from '../../browser/interaction.js';

function transition(from: string, event: string, to: string): EdgeWalkTransition {
  return { from, event, to, hasGuard: false };
}

const stdBrowseTrait: TraitWalkConfig = {
  traitName: 'BrowseItemBrowse',
  initialState: 'loading',
  transitions: [
    transition('loading', 'INIT', 'loading'),                     // boot
    transition('loading', 'BrowseItemLoaded', 'browsing'),
    transition('loading', 'BrowseItemLoadFailed', 'error'),
    transition('browsing', 'INIT', 'loading'),                    // refresh
    transition('error', 'INIT', 'loading'),                       // retry
  ],
};

describe('planWalk', () => {
  it('prepends the synthetic auto-init step by default', () => {
    const steps = planWalk({ trait: stdBrowseTrait });
    expect(steps[0].triggerKind).toBe('auto-init');
    expect(steps[0].event).toBe('INIT');
    expect(steps[0].from).toBe('loading');
    expect(steps[0].to).toBe('loading');
    expect(steps[0].coverageKey).toBe(
      'BrowseItemBrowse:loading+INIT->loading',
    );
  });

  it('skips the auto-init step when includeAutoInit is false', () => {
    const steps = planWalk({ trait: stdBrowseTrait, includeAutoInit: false });
    expect(steps.every((s) => s.triggerKind !== 'auto-init')).toBe(true);
  });

  it('every non-init step is tagged bus or replay', () => {
    const steps = planWalk({ trait: stdBrowseTrait });
    for (const step of steps) {
      expect(['auto-init', 'bus', 'replay']).toContain(step.triggerKind);
    }
  });

  it('emits stable coverage keys matching frame/keyOf', () => {
    // v3.14+: non-init transitions get a `[success]` suffix (no
    // required-payload events in std-browse → no `[malformed]`
    // variant). The auto-init step keeps the unsuffixed key.
    const steps = planWalk({ trait: stdBrowseTrait });
    for (const step of steps) {
      const suffix = step.triggerKind === 'auto-init' ? '' : '[success]';
      const expected = `BrowseItemBrowse:${step.from}+${step.event}->${step.to}${suffix}`;
      expect(step.coverageKey).toBe(expected);
    }
  });

  it('std-browse: covers all 4 walkable edges (boot INIT excluded)', () => {
    const steps = planWalk({ trait: stdBrowseTrait });
    const nonReplayKeys = steps
      .filter((s) => !s.isRepositioning)
      .map((s) => s.coverageKey);

    expect(nonReplayKeys).toContain(
      'BrowseItemBrowse:loading+INIT->loading',
    ); // auto-init
    expect(nonReplayKeys).toContain(
      'BrowseItemBrowse:loading+BrowseItemLoaded->browsing[success]',
    );
    expect(nonReplayKeys).toContain(
      'BrowseItemBrowse:loading+BrowseItemLoadFailed->error[success]',
    );
    expect(nonReplayKeys).toContain(
      'BrowseItemBrowse:browsing+INIT->loading[success]',
    ); // refresh
    expect(nonReplayKeys).toContain(
      'BrowseItemBrowse:error+INIT->loading[success]',
    ); // retry
  });

  it('handles a trait with no INIT transitions', () => {
    const trait: TraitWalkConfig = {
      traitName: 'X',
      initialState: 'a',
      transitions: [transition('a', 'GO', 'b')],
    };
    const steps = planWalk({ trait });
    // 1 auto-init + 1 walker step
    expect(steps).toHaveLength(2);
    expect(steps[0].triggerKind).toBe('auto-init');
    expect(steps[1].event).toBe('GO');
  });

  it('handles a guarded transition by emitting [success] and [guard-fail] keys', () => {
    // v3.14+: guarded transitions emit `[success]` (guard.pass + valid
    // payload) and `[guard-fail]` (guard.fail + valid payload) variants.
    // The legacy `[pass]` / `[fail]` suffixes were replaced by the more
    // explicit payloadCase tags so observers can branch on intent
    // (validator-reject vs guard-reject vs success path) without
    // re-deriving from `payload` shape.
    const guarded: EdgeWalkTransition = {
      from: 'a',
      event: 'TRY',
      to: 'b',
      hasGuard: true,
      guard: ['gt', '@payload.qty', 0],
    };
    const trait: TraitWalkConfig = {
      traitName: 'Guarded',
      initialState: 'a',
      transitions: [guarded, transition('b', 'BACK', 'a')],
    };
    const steps = planWalk({ trait });
    const guardedKeys = steps
      .filter((s) => s.event === 'TRY')
      .map((s) => s.coverageKey);
    expect(guardedKeys).toContain('Guarded:a+TRY->b[success]');
    expect(guardedKeys).toContain('Guarded:a+TRY->b[guard-fail]');
  });

  it('std-browse needs no replays — every edge is reachable in greedy DFS', () => {
    // After the @almadar/core 5.9.0 INIT-filter fix, the std-browse
    // graph is fully reachable via greedy DFS from `loading`:
    //   loading → BrowseItemLoaded → browsing → INIT → loading
    //          → BrowseItemLoadFailed → error → INIT → loading
    // No BFS repositioning needed. Steps should be all bus + auto-init.
    const steps = planWalk({ trait: stdBrowseTrait });
    const replays = steps.filter((s) => s.triggerKind === 'replay');
    expect(replays).toHaveLength(0);
    const triggerKinds = new Set(steps.map((s) => s.triggerKind));
    expect(triggerKinds.has('auto-init')).toBe(true);
    expect(triggerKinds.has('bus')).toBe(true);
  });

  describe('transient auto-advancing states (acceptStates)', () => {
    // `loading`'s entry fetch emits BrowseItemLoaded (→ browsing) on success
    // and BrowseItemLoadFailed (→ error) on failure: both effect-emitted, so
    // `loading` auto-advances and a transition INTO it settles past it.
    const asyncTrait: TraitWalkConfig = {
      ...stdBrowseTrait,
      effectEmittedEvents: new Set(['BrowseItemLoaded', 'BrowseItemLoadFailed']),
    };

    it('sets acceptStates to the transient closure for a transition into a transient state', () => {
      const steps = planWalk({ trait: asyncTrait, includeAutoInit: false });
      const refresh = steps.find((s) => s.from === 'browsing' && s.event === 'INIT' && s.to === 'loading');
      expect(refresh).toBeDefined();
      // closure(loading) = { loading, browsing, error }
      expect([...(refresh?.acceptStates ?? [])].sort()).toEqual(['browsing', 'error', 'loading']);
    });

    it('sets acceptStates to the from-closure for a step ON an effect-emitted event', () => {
      const steps = planWalk({ trait: asyncTrait, includeAutoInit: false });
      // `BrowseItemLoaded` is fired by the fetch effect, not a user. The manual
      // dispatch is a no-op nudge — the runtime is wherever the natural flow
      // settled, anywhere in `from`'s closure (= { loading, browsing, error }).
      const load = steps.find((s) => s.event === 'BrowseItemLoaded' && s.to === 'browsing' && s.payloadCase === 'success');
      expect(load).toBeDefined();
      expect([...(load?.acceptStates ?? [])].sort()).toEqual(['browsing', 'error', 'loading']);
    });

    it('excludes effect-emitted events from the replay graph (undrivable failure target)', async () => {
      const { planReplayTo } = await import('../plan-replay-to.js');
      // `error` is reachable only via `loading --BrowseItemLoadFailed--> error`,
      // an effect-emitted (fetch-failure) hop that can't be driven → no path.
      const replay = planReplayTo({ trait: asyncTrait, targetState: 'error' });
      expect(replay).toEqual([]);
    });

    it('omits acceptStates entirely when the trait declares no effect-emitted events', () => {
      const steps = planWalk({ trait: stdBrowseTrait, includeAutoInit: false });
      expect(steps.every((s) => s.acceptStates === undefined)).toBe(true);
    });
  });

  describe('guard steering honesty (guardSteerable)', () => {
    it('marks @entity-bound guard variants as unsteerable', () => {
      // Snake's steering guards bind @entity.* — the synthesized
      // `{pass:{},fail:{}}` payloads can't steer them.
      const entityGuarded: EdgeWalkTransition = {
        from: 'playing',
        event: 'UP',
        to: 'playing',
        hasGuard: true,
        guard: ['and', ['not', '@entity.over'], ['!=', '@entity.dir', 'down']],
      };
      const trait: TraitWalkConfig = {
        traitName: 'Snake',
        initialState: 'playing',
        transitions: [entityGuarded],
      };
      const steps = planWalk({ trait, includeAutoInit: false });
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step.guardSteerable).toBe(false);
      }
    });

    it('marks @config-bound guard variants as unsteerable', () => {
      const configGuarded: EdgeWalkTransition = {
        from: 'a',
        event: 'GO',
        to: 'b',
        hasGuard: true,
        guard: ['=', '@config.mode', 'edit'],
      };
      const trait: TraitWalkConfig = {
        traitName: 'Cfg',
        initialState: 'a',
        transitions: [configGuarded],
      };
      const steps = planWalk({ trait, includeAutoInit: false });
      expect(steps.every((s) => s.guardSteerable === false)).toBe(true);
    });

    it('marks a bare-string-atom @config guard unsteerable (std-data-erasure/std-mod-queue OPEN shape)', () => {
      // Real shape from the .orb registry: `OPEN -> loading when
      // @config.enabled` lowers to the guard as a bare string atom, not
      // an `["=", ...]` call — a distinct code path through
      // collectBindings/walkSExpr from the array-guard test above.
      const configGuarded: EdgeWalkTransition = {
        from: 'idle',
        event: 'OPEN',
        to: 'loading',
        hasGuard: true,
        guard: '@config.enabled',
      };
      const trait: TraitWalkConfig = {
        traitName: 'Erasure',
        initialState: 'idle',
        transitions: [configGuarded],
      };
      const steps = planWalk({ trait, includeAutoInit: false });
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.every((s) => s.guardSteerable === false)).toBe(true);
    });

    it('marks a fully const-folded literal guard (zero bindings) unsteerable, not vacuously steerable', () => {
      // Real `orbital resolve` shape for a standalone-verified atom whose
      // `@config.enabled` default (`false`) has no override in scope: the
      // resolver const-folds the guard all the way down to the literal
      // boolean `false` (std-mod-queue / std-data-erasure OPEN, verified
      // directly). `collectBindings(false) === []`, and `[].every(...)`
      // is vacuously `true` — the exact inversion this guards against.
      const constFolded: EdgeWalkTransition = {
        from: 'idle',
        event: 'OPEN',
        to: 'loading',
        hasGuard: true,
        guard: false,
      };
      const trait: TraitWalkConfig = {
        traitName: 'ModQueueItemReview',
        initialState: 'idle',
        transitions: [constFolded],
      };
      const steps = planWalk({ trait, includeAutoInit: false });
      // constant `false` means canPass is false — only the guard-fail
      // variant is emitted (matches the real frame evidence: one 'fail'
      // frame, no counterpart 'pass' frame).
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.every((s) => s.guardCase === 'fail')).toBe(true);
      expect(steps.every((s) => s.guardSteerable === false)).toBe(true);
    });

    it('leaves @payload-bound guard variants steerable', () => {
      const payloadGuarded: EdgeWalkTransition = {
        from: 'a',
        event: 'TRY',
        to: 'b',
        hasGuard: true,
        guard: ['>', '@payload.qty', 0],
      };
      const trait: TraitWalkConfig = {
        traitName: 'Guarded',
        initialState: 'a',
        transitions: [payloadGuarded],
      };
      const steps = planWalk({ trait, includeAutoInit: false });
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step.guardSteerable).toBe(true);
      }
    });

    it('a guard mixing @payload and @entity is unsteerable (entity side unreachable)', () => {
      const mixed: EdgeWalkTransition = {
        from: 'a',
        event: 'TRY',
        to: 'b',
        hasGuard: true,
        guard: ['and', ['gt', '@payload.qty', 0], ['not', '@entity.over']],
      };
      const trait: TraitWalkConfig = {
        traitName: 'Mixed',
        initialState: 'a',
        transitions: [mixed],
      };
      const steps = planWalk({ trait, includeAutoInit: false });
      expect(steps.every((s) => s.guardSteerable === false)).toBe(true);
    });

    it('unguarded steps carry no guardSteerable stamp', () => {
      const steps = planWalk({ trait: stdBrowseTrait });
      expect(steps.every((s) => s.guardSteerable === undefined)).toBe(true);
    });
  });

  describe('guardSiblingTargets', () => {
    it('a guard-fail probe on complementary arms carries the sibling targets', () => {
      // std-ml-similarity's COMPARE shape: two guarded arms on one event.
      const trait: TraitWalkConfig = {
        traitName: 'SimilarityRun',
        initialState: 'idle',
        transitions: [
          {
            from: 'idle', event: 'COMPARE', to: 'embedding',
            hasGuard: true, guard: ['>', ['array/len', '@payload.candidates'], 0],
          },
          {
            from: 'idle', event: 'COMPARE', to: 'resolved',
            hasGuard: true, guard: ['==', ['array/len', '@payload.candidates'], 0],
          },
        ],
      };
      const steps = planWalk({ trait, includeAutoInit: false });
      const failSteps = steps.filter((s) => s.guardCase === 'fail');
      expect(failSteps.length).toBeGreaterThan(0);
      const embeddingFail = failSteps.find((s) => s.to === 'embedding');
      expect(embeddingFail?.guardSiblingTargets).toEqual(['resolved']);
      const resolvedFail = failSteps.find((s) => s.to === 'resolved');
      expect(resolvedFail?.guardSiblingTargets).toEqual(['embedding']);
    });

    it('a single-arm guard-fail probe carries no sibling stamp', () => {
      const trait: TraitWalkConfig = {
        traitName: 'Single',
        initialState: 'a',
        transitions: [
          { from: 'a', event: 'GO', to: 'b', hasGuard: true, guard: ['>', '@payload.n', 0] },
        ],
      };
      const steps = planWalk({ trait, includeAutoInit: false });
      const fail = steps.find((s) => s.guardCase === 'fail');
      expect(fail?.guardSiblingTargets).toBeUndefined();
    });
  });
});

describe('planWalk — guarded pass variants carry their establishing preamble when the schema is given', () => {
  const composerTrait: TraitWalkConfig = {
    traitName: 'ChatComposer',
    initialState: 'ready',
    linkedEntity: 'ChatMessage',
    transitions: [
      transition('ready', 'INIT', 'ready'),
      transition('ready', 'DRAFT_CHANGED', 'ready'),
      {
        from: 'ready',
        event: 'SEND',
        to: 'ready',
        hasGuard: true,
        guard: ['and', '@entity.activeChannel', ['not', ['=', ['str/default', '@entity.draft', ''], '']]],
      },
    ],
  };
  const composerDecl: Trait = {
    name: 'ChatComposer',
    scope: 'instance',
    linkedEntity: 'ChatMessage',
    stateMachine: {
      states: [{ name: 'ready', isInitial: true }],
      events: [
        { key: 'INIT', name: 'Init' },
        { key: 'DRAFT_CHANGED', name: 'Draft Changed', payloadSchema: [{ name: 'value', type: 'string' as const }] },
        { key: 'SEND', name: 'Send' },
      ],
      transitions: [
        { from: 'ready', to: 'ready', event: 'INIT', effects: [['set', '@entity.draft', ''], ['set', '@entity.activeChannel', 'general']] },
        { from: 'ready', to: 'ready', event: 'DRAFT_CHANGED', effects: [['set', '@entity.draft', '@payload.value']] },
        {
          from: 'ready',
          to: 'ready',
          event: 'SEND',
          guard: ['and', '@entity.activeChannel', ['not', ['=', ['str/default', '@entity.draft', ''], '']]],
          effects: [['emit', 'SAVE', { data: { content: '@entity.draft' } }]],
        },
      ],
    },
  };
  const orbital: OrbitalSchema = {
    name: 'efficacy-chat',
    version: '1.0.0',
    orbitals: [{
      name: 'ChatMessageOrbital',
      entity: { name: 'ChatMessage', fields: [{ name: 'id', type: 'string' as const, required: true }, { name: 'draft', type: 'string' as const }, { name: 'activeChannel', type: 'string' as const }] },
      traits: [composerDecl],
      pages: [],
    }],
  };

  it('attaches DRAFT_CHANGED as the SEND pass variant\'s preamble', () => {
    const steps = planWalk({ trait: composerTrait, orbital });
    const sendPass = steps.find((s) => s.event === 'SEND' && s.guardCase === 'pass');
    expect(sendPass?.establishesRow?.event).toBe('DRAFT_CHANGED');
    expect(sendPass?.establishesRow?.beforeReplay).toBe(true);
    const sendFail = steps.find((s) => s.event === 'SEND' && s.guardCase === 'fail');
    expect(sendFail?.establishesRow).toBeUndefined();
  });

  it('plans no preamble without the schema (pre-existing callers unchanged)', () => {
    const steps = planWalk({ trait: composerTrait });
    const sendPass = steps.find((s) => s.event === 'SEND' && s.guardCase === 'pass');
    expect(sendPass?.establishesRow).toBeUndefined();
    expect(sendPass?.unreachableRowReason).toBeUndefined();
  });

  it('records the unreachable reason when no setter can satisfy the guard', () => {
    const noSetter: OrbitalSchema = {
      ...orbital,
      orbitals: [{
        ...orbital.orbitals[0],
        traits: [{
          ...composerDecl,
          stateMachine: {
            ...composerDecl.stateMachine!,
            transitions: composerDecl.stateMachine!.transitions.map((t) =>
              t.event === 'DRAFT_CHANGED' ? { ...t, effects: [['set', '@entity.pendingAttachment', '@payload.value']] } : t,
            ),
          },
        }],
      }],
    };
    const steps = planWalk({ trait: composerTrait, orbital: noSetter });
    const sendPass = steps.find((s) => s.event === 'SEND' && s.guardCase === 'pass');
    expect(sendPass?.unreachableRowReason).toContain('guard-precondition-unreachable');
  });
});

describe('PF-17a: str/default-nonempty guard fail steering', () => {
  it('steers the guard-fail variant to the str/default fallback so the guard genuinely fails', () => {
    // EntryLockApply.LOCK_ENTRY: `when (!= (str/default ?entityId "") "")` —
    // buildGuardPayloads can't see through str/default, so its fail payload
    // left the synthesized non-empty entityId in place and the "fail"
    // dispatch passed. The planner now forces the field to the fallback.
    const lockGuarded: EdgeWalkTransition = {
      from: 'open',
      event: 'LOCK_ENTRY',
      to: 'locked',
      hasGuard: true,
      guard: ['!=', ['str/default', '@payload.entityId', ''], ''],
    };
    const trait: TraitWalkConfig = {
      traitName: 'EntryLockApply',
      initialState: 'open',
      events: [{ key: 'LOCK_ENTRY', name: 'Lock Entry', payloadSchema: [{ name: 'entityId', type: 'string', required: true }] }],
      transitions: [lockGuarded],
    };
    const steps = planWalk({ trait, includeAutoInit: false });
    const fail = steps.find((s) => s.payloadCase === 'guard-fail');
    expect(fail?.payload['entityId']).toBe('');
    const pass = steps.find((s) => s.guardCase === 'pass');
    expect(pass).toBeDefined();
    expect(pass?.payload['entityId'] === '').toBe(false);
    expect(pass?.payload['entityId'] === undefined).toBe(false);
  });
});

describe('PF-15(b): fetch-data injection', () => {
  it('shapes a non-empty entity-row array for a guard reading (array/len ?data)', () => {
    // DirectMessageStarter.AUTO_OPEN: `when (and (not @entity.openChannel)
    // (> (array/len ?data) 0))` on `data : [ChannelMember]` — the pass payload
    // must carry real ChannelMember-shaped rows, not bare mock-id objects.
    const autoOpen: EdgeWalkTransition = {
      from: 'idle',
      event: 'AUTO_OPEN',
      to: 'idle',
      hasGuard: true,
      guard: ['and', ['not', '@entity.openChannel'], ['>', ['array/len', '@payload.data'], 0]],
    };
    const trait: TraitWalkConfig = {
      traitName: 'DirectMessageStarter',
      initialState: 'idle',
      linkedEntity: 'ChannelMember',
      events: [{ key: 'AUTO_OPEN', name: 'Auto Open', payloadSchema: [{ name: 'data', type: '[ChannelMember]' }] }],
      transitions: [autoOpen],
    };
    const entityFieldsByName: Record<string, EntityFieldDef[]> = {
      ChannelMember: [
        { name: 'id', type: 'string', required: true },
        { name: 'channel', type: 'string' },
        { name: 'lastMessageAt', type: 'string' },
      ],
    };
    const steps = planWalk({ trait, includeAutoInit: false, entityFieldsByName });
    const pass = steps.find((s) => s.guardCase === 'pass');
    const data = pass?.payload['data'];
    expect(Array.isArray(data)).toBe(true);
    expect((data as ReadonlyArray<Record<string, unknown>>).length).toBeGreaterThan(0);
    expect((data as ReadonlyArray<Record<string, unknown>>)[0]).toHaveProperty('channel');
    expect((data as ReadonlyArray<Record<string, unknown>>)[0]).toHaveProperty('lastMessageAt');
  });
});

describe('conformGuardPayload', () => {
  const schema = [
    { name: 'hasFile', type: 'boolean', required: true },
    { name: 'name', type: 'string', required: true },
    { name: 'row', type: 'object', required: false },
  ];
  const mock = { id: 'mock-test-id', name: 'mock-test-name' };

  it('replaces a row-shaped mock on a declared primitive field with the typed satisfying value', () => {
    const out = conformGuardPayload({ hasFile: mock, name: mock }, schema, { hasFile: false, name: 'ember' });
    expect(out).toEqual({ hasFile: true, name: 'ember' });
  });

  it('replaces a null on a declared primitive field with the typed falsy value, since the validator refuses null', () => {
    const out = conformGuardPayload({ hasFile: null, name: null }, schema, { name: 'ember' });
    expect(out).toEqual({ hasFile: false, name: '' });
  });

  it('control: leaves a row on a declared object field, a null on it and already-typed values alone', () => {
    const out = conformGuardPayload({ hasFile: true, name: 'x', row: mock }, schema, { name: 'ember' });
    expect(out).toEqual({ hasFile: true, name: 'x', row: mock });
    expect(conformGuardPayload({ row: null }, schema, {})).toEqual({ row: null });
  });
});

describe('planWalk: per-arm guard solving', () => {
  const replyTrait: TraitWalkConfig = {
    traitName: 'Fetcher',
    initialState: 'idle',
    transitions: [
      { from: 'idle', event: 'ASK', to: 'choosing', hasGuard: false },
      { from: 'choosing', event: 'CHOSEN', to: 'done', hasGuard: true, guard: ['and', ['>=', '@payload.status', 200], ['<', '@payload.status', 300]] },
      { from: 'choosing', event: 'CHOSEN', to: 'rejected', hasGuard: true, guard: ['>=', '@payload.status', 300] },
      { from: 'choosing', event: 'OTHER', to: 'failed', hasGuard: false },
    ],
      };

  it('plans each guarded arm as its own step with a payload that satisfies that arm\'s guard', () => {
    const steps = planWalk({ trait: replyTrait, includeAutoInit: false });
    const pass = (to: string) => steps.find((s) => s.event === 'CHOSEN' && s.to === to && s.guardCase === 'pass');
    const ok = pass('done');
    const rejected = pass('rejected');
    expect(ok).toBeDefined();
    expect(rejected).toBeDefined();
    const okStatus = Number(ok?.payload.status);
    const rejectedStatus = Number(rejected?.payload.status);
    expect(okStatus >= 200 && okStatus < 300).toBe(true);
    expect(rejectedStatus >= 300).toBe(true);
  });

  it('credits both disjoint arms as conclusive', () => {
    const steps = planWalk({ trait: replyTrait, includeAutoInit: false });
    const passes = steps.filter((s) => s.event === 'CHOSEN' && s.guardCase === 'pass');
    expect(passes).toHaveLength(2);
    for (const step of passes) {
      expect(step.guardSteerable).toBe(true);
      expect(step.inconclusive).toBeUndefined();
    }
  });

  it('reports the later of two overlapping arms as an inconclusive gap, never a pass', () => {
    const overlapping: TraitWalkConfig = {
      ...replyTrait,
      transitions: [
        replyTrait.transitions[0],
        { from: 'choosing', event: 'CHOSEN', to: 'done', hasGuard: true, guard: ['>=', '@payload.status', 200] },
        { from: 'choosing', event: 'CHOSEN', to: 'rejected', hasGuard: true, guard: ['>=', '@payload.status', 300] },
      ],
    };
    const passes = planWalk({ trait: overlapping, includeAutoInit: false }).filter((s) => s.event === 'CHOSEN' && s.guardCase === 'pass');
    const first = passes.find((s) => s.to === 'done');
    const second = passes.find((s) => s.to === 'rejected');
    expect(first?.inconclusive).toBeUndefined();
    expect(second?.guardSteerable).toBe(false);
    expect(second?.inconclusive).toContain('passes the earlier arm 0');
  });

  it('reports an arm whose guard the solved payload cannot satisfy as an inconclusive gap', () => {
    const unsolvable: TraitWalkConfig = {
      ...replyTrait,
      transitions: [
        replyTrait.transitions[0],
        { from: 'choosing', event: 'CHOSEN', to: 'done', hasGuard: true, guard: ['and', ['>=', '@payload.status', 300], ['<', '@payload.status', 200]] },
      ],
    };
    const pass = planWalk({ trait: unsolvable, includeAutoInit: false }).find((s) => s.event === 'CHOSEN' && s.guardCase === 'pass');
    expect(pass?.guardSteerable).toBe(false);
    expect(pass?.inconclusive).toContain("does not pass this arm's guard");
  });
});

describe('planWalk: http routes', () => {
  const httpTrait: TraitWalkConfig = {
    traitName: 'Fetcher',
    initialState: 'idle',
    transitions: [
      { from: 'idle', event: 'ASK', to: 'requesting', hasGuard: false },
      { from: 'requesting', event: 'REPLIED', to: 'done', hasGuard: true, guard: ['and', ['>=', '@payload.status', 200], ['<', '@payload.status', 300]] },
      { from: 'requesting', event: 'REPLIED', to: 'rejected', hasGuard: true, guard: ['>=', '@payload.status', 300] },
      { from: 'requesting', event: 'FAILED', to: 'failed', hasGuard: false },
    ],
    effectEmittedEvents: new Set(['REPLIED', 'FAILED']),
    httpReplyEvents: new Set(['REPLIED']),
    httpFailureEvents: new Set(['FAILED']),
  };

  it('plans neither the reply arms nor the failure arm as standalone steps', () => {
    const steps = planWalk({ trait: httpTrait, includeAutoInit: false });
    expect(steps.map((s) => s.event)).toEqual(['ASK']);
  });

  it('control: the same trait without http route sets plans every arm', () => {
    const { httpReplyEvents: _reply, httpFailureEvents: _failure, ...plain } = httpTrait;
    const events = new Set(planWalk({ trait: plain, includeAutoInit: false }).map((s) => s.event));
    expect(events).toEqual(new Set(['ASK', 'REPLIED', 'FAILED']));
  });
});

describe('planWalk: guard-fail on same-target sibling arms', () => {
  const trait: TraitWalkConfig = {
    traitName: 'Gate',
    initialState: 'idle',
    transitions: [
      { from: 'idle', event: 'GO', to: 'idle', hasGuard: true, guard: ['>=', '@payload.n', 5] },
      { from: 'idle', event: 'GO', to: 'idle', hasGuard: true, guard: ['<', '@payload.n', 5] },
    ],
  };

  it('names the target of the sibling arm that catches the failing payload, even when it equals this arm\'s target', () => {
    const fail = planWalk({ trait, includeAutoInit: false }).find((s) => s.guardCase === 'fail' && s.arm === 0);
    expect(fail?.guardSiblingTargets).toEqual(['idle']);
  });

  it('control: a lone guarded arm has no sibling to catch its failing payload', () => {
    const lone: TraitWalkConfig = { ...trait, transitions: [trait.transitions[0]] };
    const fail = planWalk({ trait: lone, includeAutoInit: false }).find((s) => s.guardCase === 'fail');
    expect(fail?.guardSiblingTargets).toBeUndefined();
  });

  it('reports a fail variant whose payload still passes its own guard as an inconclusive gap, never a prediction', () => {
    const unfalsifiable: TraitWalkConfig = {
      ...trait,
      transitions: [{ from: 'idle', event: 'GO', to: 'idle', hasGuard: true, guard: ['=', ['str/len', '@payload.s'], ['str/len', '@payload.s']] }],
    };
    const fail = planWalk({ trait: unfalsifiable, includeAutoInit: false }).find((s) => s.guardCase === 'fail');
    expect(fail?.guardSteerable).toBe(false);
    expect(fail?.inconclusive).toContain('does not fail this arm');
  });
});

describe('planWalk: json/parse payload fields', () => {
  const pending = [
    { name: 'key', type: 'string' },
    { name: 'size', type: 'number' },
    { name: 'isPublic', type: 'boolean' },
  ] as const;
  const schema: OrbitalSchema = {
    name: 'parse',
    orbitals: [{ name: 'O', entity: { name: 'Thing', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] }, types: { Pending: [...pending] }, traits: [], pages: [] }],
  };
  const trait: TraitWalkConfig = {
    traitName: 'Saver',
    initialState: 'idle',
    events: [{ key: 'DONE', name: 'Done', payloadSchema: [{ name: 'state', type: 'string', required: true }, { name: 'other', type: 'string', required: true }] }],
    transitions: [{
      from: 'idle', event: 'DONE', to: 'idle', hasGuard: false,
      effects: [['let', [['u', ['json/parse', '@payload.state', 'Pending']]], ['emit', 'SAVED', { key: '@u.key' }]]],
    }],
  };

  it('synthesizes a payload field read through json/parse as the JSON text of a minimal instance of its type', () => {
    const step = planWalk({ trait, orbital: schema, includeAutoInit: false }).find((s) => s.payloadCase === 'success');
    const state = step?.payload.state;
    if (typeof state !== 'string') throw new Error('state is not text');
    const parsed: Record<string, unknown> = JSON.parse(state);
    expect(typeof parsed.key).toBe('string');
    expect(parsed.key).not.toBe('');
    expect(typeof parsed.size).toBe('number');
    expect(typeof parsed.isPublic).toBe('boolean');
  });

  it('fills a member of the parsed instance that the arm parses again with an instance of that member\'s own type', () => {
    const nested: TraitWalkConfig = {
      ...trait,
      transitions: [{
        from: 'idle', event: 'DONE', to: 'idle', hasGuard: false,
        effects: [['let', [['u', ['json/parse', '@payload.state', 'Pending']]], ['let', [['b', ['json/parse', '@u.batch', 'Pending']]], ['emit', 'SAVED', { key: '@b.key' }]]]],
      }],
    };
    const withBatch: OrbitalSchema = { ...schema, orbitals: [{ ...schema.orbitals[0], types: { Pending: [...pending, { name: 'batch', type: 'string' }] } }] };
    const step = planWalk({ trait: nested, orbital: withBatch, includeAutoInit: false }).find((s) => s.payloadCase === 'success');
    const inner = JSON.parse(String(JSON.parse(String(step?.payload.state)).batch));
    expect(typeof inner.key).toBe('string');
  });

  it('control: a field not read through json/parse stays plain synthesized text', () => {
    const step = planWalk({ trait, orbital: schema, includeAutoInit: false }).find((s) => s.payloadCase === 'success');
    const other = step?.payload.other;
    expect(typeof other).toBe('string');
    expect(() => JSON.parse(String(other))).toThrow();
  });
});

describe('planWalk: guards over json/parse instances', () => {
  const schema: OrbitalSchema = {
    name: 'parse-guards',
    orbitals: [{
      name: 'O',
      entity: { name: 'Thing', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
      types: {
        Item: [{ name: 'name', type: 'string' }],
        Pending: [{ name: 'mode', type: 'string' }, { name: 'key', type: 'string' }],
        Batch: [{ name: 'items', type: '[Item]' }, { name: 'idx', type: 'number' }],
      },
      traits: [],
      pages: [],
    }],
  };
  const events = [{ key: 'DONE', name: 'Done', payloadSchema: [{ name: 'state', type: 'string', required: true }] }, { key: 'NEXT', name: 'Next', payloadSchema: [{ name: 'batch', type: 'string', required: true }] }];

  it('solves each arm\'s json member from the guard so the arm is walked, not reported inconclusive', () => {
    const trait: TraitWalkConfig = {
      traitName: 'Saver', initialState: 'idle', events,
      transitions: [
        { from: 'idle', event: 'DONE', to: 'idle', hasGuard: true, guard: ['=', ['object/get', ['json/parse', '@payload.state', 'Pending'], 'mode', 'single'], 'single'] },
        { from: 'idle', event: 'DONE', to: 'idle', hasGuard: true, guard: ['=', ['object/get', ['json/parse', '@payload.state', 'Pending'], 'mode', 'single'], 'batch'] },
      ],
    };
    const passes = planWalk({ trait, orbital: schema, includeAutoInit: false }).filter((s) => s.event === 'DONE' && s.guardCase === 'pass');
    expect(passes).toHaveLength(2);
    expect(passes.map((s) => JSON.parse(String(s.payload.state)).mode)).toEqual(['single', 'batch']);
    for (const step of passes) expect(step.inconclusive).toBeUndefined();
  });

  it('solves two members together: an index below the length needs a non-empty array and a zero index', () => {
    const trait: TraitWalkConfig = {
      traitName: 'Batcher', initialState: 'idle', events,
      transitions: [
        { from: 'idle', event: 'NEXT', to: 'idle', hasGuard: true, guard: ['<', ['object/get', ['json/parse', '@payload.batch', 'Batch'], 'idx', 0], ['array/len', ['object/get', ['json/parse', '@payload.batch', 'Batch'], 'items', []]]] },
      ],
    };
    const pass = planWalk({ trait, orbital: schema, includeAutoInit: false }).find((s) => s.guardCase === 'pass');
    const batch = JSON.parse(String(pass?.payload.batch));
    expect(batch.items.length).toBeGreaterThan(batch.idx);
    expect(pass?.inconclusive).toBeUndefined();
  });
});
