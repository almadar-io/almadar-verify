import { describe, it, expect } from 'vitest';
import type { EdgeWalkTransition } from '@almadar/core';
import { planReplayTo } from '../plan-replay-to.js';
import type { TraitWalkConfig } from '../../engine/types.js';
import type { ExtendedWalkStep } from '../types.js';

function transition(from: string, event: string, to: string): EdgeWalkTransition {
  return { from, event, to, hasGuard: false };
}

/** Narrow a `planReplayTo` result for tests that expect a real hop chain. */
function expectPath(replay: ExtendedWalkStep[] | null): ExtendedWalkStep[] {
  if (replay === null) throw new Error('expected a non-null replay path');
  return replay;
}

describe('planReplayTo', () => {
  it('returns [] when target is the initial state', () => {
    const trait: TraitWalkConfig = {
      traitName: 'X',
      initialState: 'a',
      transitions: [transition('a', 'GO', 'b')],
    };
    expect(planReplayTo({ trait, targetState: 'a' })).toEqual([]);
  });

  it('returns the BFS shortest path to the target state', () => {
    const trait: TraitWalkConfig = {
      traitName: 'X',
      initialState: 'a',
      transitions: [
        transition('a', 'GO', 'b'),
        transition('b', 'NEXT', 'c'),
      ],
    };
    const steps = expectPath(planReplayTo({ trait, targetState: 'c' }));
    expect(steps).toHaveLength(2);
    expect(steps[0].event).toBe('GO');
    expect(steps[1].event).toBe('NEXT');
    for (const step of steps) {
      expect(step.triggerKind).toBe('replay');
      expect(step.isRepositioning).toBe(true);
      expect(step.coverageKey).toMatch(/\[replay\]$/);
    }
  });

  it('returns null when the target has no dispatchable path at all (genuinely unreachable)', () => {
    const trait: TraitWalkConfig = {
      traitName: 'X',
      initialState: 'a',
      transitions: [transition('a', 'GO', 'b')],
    };
    expect(planReplayTo({ trait, targetState: 'unreachable' })).toBeNull();
  });

  describe('acceptStates — reconcile-hop transient closure (verifier-precision fix)', () => {
    // Mirrors std-cache-aside's empty→loading→{cached,error} shape: a
    // reconcile hop walking back to `loading` as a precondition can settle
    // anywhere in `loading`'s transient closure (the mocked fetch resolving
    // inside the settle window), same as a direct step into `loading` would.
    const cacheAsideTrait: TraitWalkConfig = {
      traitName: 'CacheEntryCacheManager',
      initialState: 'empty',
      transitions: [
        transition('empty', 'INIT', 'empty'),
        transition('empty', 'FETCH', 'loading'),
        transition('loading', 'Loaded', 'cached'),
        transition('loading', 'Failed', 'error'),
      ],
      effectEmittedEvents: new Set(['Loaded', 'Failed']),
    };

    it('attaches the transient closure of the hop target as acceptStates', () => {
      const replay = expectPath(planReplayTo({ trait: cacheAsideTrait, targetState: 'loading' }));
      expect(replay).toHaveLength(1);
      expect(replay[0].event).toBe('FETCH');
      expect([...(replay[0].acceptStates ?? [])].sort()).toEqual(['cached', 'error', 'loading']);
    });

    it("matches planWalk's closure computation for the same two-effect-edge state", async () => {
      const { planWalk } = await import('../plan-walk.js');
      // A direct transition INTO `loading` (e.g. an `error` retry) gets the
      // identical closure via planWalk's own acceptStates computation —
      // both planners must agree on the closure of the same state.
      const retryTrait: TraitWalkConfig = {
        ...cacheAsideTrait,
        transitions: [...cacheAsideTrait.transitions, transition('error', 'RETRY', 'loading')],
      };
      const steps = planWalk({ trait: retryTrait, includeAutoInit: false });
      const retry = steps.find((s) => s.event === 'RETRY');
      expect(retry).toBeDefined();
      const replay = expectPath(planReplayTo({ trait: cacheAsideTrait, targetState: 'loading' }));
      expect([...(retry?.acceptStates ?? [])].sort()).toEqual(
        [...(replay[0].acceptStates ?? [])].sort(),
      );
    });

    it('omits acceptStates when the hop target has no effect-emitted outgoing edges', () => {
      const trait: TraitWalkConfig = {
        traitName: 'X',
        initialState: 'a',
        transitions: [transition('a', 'GO', 'b')],
      };
      const replay = expectPath(planReplayTo({ trait, targetState: 'b' }));
      expect(replay[0].acceptStates).toBeUndefined();
    });
  });

  describe('GAP 3 — reachability through a transient closure', () => {
    // Mirrors std-cache-aside's shape again: `cached` is reachable ONLY via
    // the effect-emitted `Loaded` transition, which BFS excludes as a HOP
    // (a reconcile step can't dispatch it manually). Pre-fix this made
    // `cached` "unreachable" (null) even though a hop landing on `loading`
    // reaches it on its own once the mocked fetch settles.
    const cacheAsideTrait: TraitWalkConfig = {
      traitName: 'CacheEntryCacheManager',
      initialState: 'empty',
      transitions: [
        transition('empty', 'INIT', 'empty'),
        transition('empty', 'FETCH', 'loading'),
        transition('loading', 'Loaded', 'cached'),
        transition('loading', 'Failed', 'error'),
      ],
      effectEmittedEvents: new Set(['Loaded', 'Failed']),
    };

    it('finds a target reachable only via the landing state\'s transient closure', () => {
      const replay = expectPath(planReplayTo({ trait: cacheAsideTrait, targetState: 'cached' }));
      expect(replay).toHaveLength(1);
      expect(replay[0].event).toBe('FETCH');
      expect(replay[0].to).toBe('loading');
      expect([...(replay[0].acceptStates ?? [])].sort()).toEqual(['cached', 'error', 'loading']);
    });

    it("matches std-approval-gate's shape: reviewing is reachable only via loading's closure", () => {
      // idle --OPEN--> loading --(effect-emitted)ApprovalRequestLoaded--> reviewing.
      // APPROVE only exists from `reviewing`; pre-fix, planReplayTo({targetState:
      // 'reviewing'}) returned null (BFS dead-ends at `loading`, since the only
      // other edge is effect-emitted and excluded) and the walker dispatched
      // APPROVE straight from `idle`.
      const approvalGateTrait: TraitWalkConfig = {
        traitName: 'ApprovalGateReview',
        initialState: 'idle',
        transitions: [
          transition('idle', 'OPEN', 'loading'),
          transition('loading', 'ApprovalRequestLoaded', 'reviewing'),
          transition('loading', 'ApprovalRequestLoadFailed', 'error'),
          transition('reviewing', 'APPROVE', 'reviewing'),
          transition('reviewing', 'CLOSE', 'idle'),
        ],
        effectEmittedEvents: new Set(['ApprovalRequestLoaded', 'ApprovalRequestLoadFailed']),
      };
      const replay = expectPath(planReplayTo({ trait: approvalGateTrait, targetState: 'reviewing' }));
      expect(replay).toHaveLength(1);
      expect(replay[0].event).toBe('OPEN');
      expect(replay[0].to).toBe('loading');
      expect(replay[0].acceptStates ?? []).toContain('reviewing');
    });

    it('still returns null when the target has no dispatchable path at all (genuinely unreachable)', () => {
      const disconnected: TraitWalkConfig = {
        traitName: 'X',
        initialState: 'a',
        transitions: [transition('a', 'GO', 'b')],
      };
      expect(planReplayTo({ trait: disconnected, targetState: 'nowhere' })).toBeNull();
    });

    it('returns [] with zero hops when the target is already in the SOURCE\'s own closure (std-data-erasure execScanning shape)', () => {
      // idle --(tick-fired, effect-emitted)ExecScanLoaded--> execScanning:
      // no manually-dispatchable edge sits between `idle` and `execScanning`
      // at all — the trait reaches it purely by sitting at idle while the
      // tick fires. Pre-fix, BFS only checked closures of states reached
      // VIA a hop, never the source itself before taking one, so this
      // target was misreported unreachable (`null`) — which then made
      // every transition FROM `execScanning` uncovered, dropping std-data-
      // erasure's coverage below 100%.
      const erasureTrait: TraitWalkConfig = {
        traitName: 'ErasureWorkflow',
        initialState: 'idle',
        transitions: [
          transition('idle', 'INIT', 'idle'),
          transition('idle', 'ExecScanLoaded', 'execScanning'),
          transition('idle', 'ExecScanFailed', 'idle'),
          transition('execScanning', 'ExecStepped', 'execScanning'),
          transition('execScanning', 'ExecScanLoaded', 'execScanning'),
        ],
        effectEmittedEvents: new Set(['ExecScanLoaded', 'ExecScanFailed', 'ExecStepped']),
      };
      expect(planReplayTo({ trait: erasureTrait, targetState: 'execScanning' })).toEqual([]);
    });

    // RV item 26: `browsing` has NO real incoming edge at all — the ONLY
    // way there is `loading`'s transient settle — so it can only enter the
    // BFS frontier via closure-flooding, never ordinary edge traversal.
    // Pre-fix this made `replying` (and `SUBMIT_REPLY`'s own target)
    // unreachable (`null`), silently excluding ChannelThread's whole
    // `replying`-sourced arm set from the walk.
    it("chains a transient settle into a further REAL hop (std-realtime-chat's ChannelThread shape: loading -(transient)-> browsing -REPLY-> replying)", () => {
      const channelThreadTrait: TraitWalkConfig = {
        traitName: 'ChannelThread',
        initialState: 'loading',
        transitions: [
          transition('loading', 'ThreadPostLoaded', 'browsing'),
          transition('browsing', 'SELECT', 'browsing'),
          transition('browsing', 'REPLY', 'replying'),
          transition('replying', 'EDIT_REPLY', 'replying'),
          transition('replying', 'SUBMIT_REPLY', 'browsing'),
          transition('replying', 'CANCEL_REPLY', 'browsing'),
        ],
        effectEmittedEvents: new Set(['ThreadPostLoaded']),
      };

      const toReplying = expectPath(planReplayTo({ trait: channelThreadTrait, targetState: 'replying' }));
      expect(toReplying).toHaveLength(1);
      expect(toReplying[0].from).toBe('browsing');
      expect(toReplying[0].event).toBe('REPLY');
      expect(toReplying[0].to).toBe('replying');

      // `browsing` sits in `loading`'s OWN transient closure — zero hops,
      // the pre-existing (already-working) zero-hop case.
      expect(planReplayTo({ trait: channelThreadTrait, targetState: 'browsing' })).toEqual([]);
    });

    it('chains a transient settle into TWO further real hops (the target itself only reachable by dispatching through the transiently-reached launch point)', () => {
      const trait: TraitWalkConfig = {
        traitName: 'X',
        initialState: 'loading',
        transitions: [
          transition('loading', 'Loaded', 'browsing'),
          transition('browsing', 'REPLY', 'replying'),
          transition('replying', 'EDIT_REPLY', 'editing'),
        ],
        effectEmittedEvents: new Set(['Loaded']),
      };
      const toEditing = expectPath(planReplayTo({ trait, targetState: 'editing' }));
      expect(toEditing.map((s) => s.event)).toEqual(['REPLY', 'EDIT_REPLY']);
      expect(toEditing[0].from).toBe('browsing');
      expect(toEditing[1].from).toBe('replying');
    });
  });

  describe('navigates (item D generalization)', () => {
    it('stamps navigates: true on a replay hop whose edge navigates (e.g. a navigate-back arm)', () => {
      // `step.edge` here is exactly what `extractTraitWalkConfigs` produces
      // via `dispatchNavigates` — a `WalkTransition` with `navigates: true`
      // stamped whether the transition navigates directly OR a listener's
      // triggered arm does. `planReplayTo` must copy that flag onto its own
      // step (same spread `plan-walk.ts`'s `makeStep` uses), or a reconcile
      // hop over a navigating edge misreports as a stateless dispatch.
      const trait: TraitWalkConfig = {
        traitName: 'DetailLayout',
        initialState: 'idle',
        transitions: [
          { from: 'idle', event: 'BACK', to: 'composing', hasGuard: false, navigates: true },
          { from: 'composing', event: 'NEXT', to: 'done', hasGuard: false },
        ],
      };
      const steps = expectPath(planReplayTo({ trait, targetState: 'done' }));
      expect(steps).toHaveLength(2);
      expect(steps[0].event).toBe('BACK');
      expect(steps[0].navigates).toBe(true);
      expect(steps[1].event).toBe('NEXT');
      expect(steps[1].navigates).toBeUndefined();
    });
  });
});
