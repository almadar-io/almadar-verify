import { describe, it, expect } from 'vitest';
import type { EffectTrace, EventLogEntry, Orbital, OrbitalSchema, VerificationSnapshot } from '@almadar/core';
import { assertEffectFailureNotSurfaced, FAILURE_SURFACE_PATTERNS } from '../effect-failure-not-surfaced.js';
import type { Frame, FrameCause } from '../../frame/types.js';

const emptyDom = { url: '', rowsByEntity: {}, portals: [], visibleTextSample: '' };
const toastDom = {
  url: '',
  rowsByEntity: {},
  portals: [{ slot: 'toast' as const, mounted: true, childCount: 1 }],
  visibleTextSample: '',
};
const mainDom = (pattern: string | undefined) => ({
  url: '',
  rowsByEntity: {},
  portals: [{ slot: 'main' as const, mounted: true, childCount: 1, pattern }],
  visibleTextSample: '',
});
const emptySnapshot: VerificationSnapshot = {
  checks: [],
  transitions: [],
  bridge: null,
  summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
  traits: [],
};

const persistCause = (guardCase: FrameCause['guardCase'] = null): FrameCause => ({
  traitName: 'CartItemPersistor',
  from: 'idle',
  event: 'SAVE',
  to: 'saving',
  guardCase,
  triggerKind: 'dom',
  isRepositioning: false,
});

function frame(
  index: number,
  cause: FrameCause,
  effectResults: ReadonlyArray<EffectTrace> = [],
  eventLogAdded: ReadonlyArray<EventLogEntry> = [],
  domSnapshot: Frame['domSnapshot'] = emptyDom,
): Frame {
  return {
    index,
    timestamp: 1000 + index,
    cause,
    stateBefore: cause.from,
    stateAfter: cause.to,
    payload: {},
    eventFired: cause.event,
    runtimeSnapshot: emptySnapshot,
    domSnapshot,
    consoleDelta: { added: [], newErrors: 0, newWarnings: 0 },
    eventLogDelta: { added: eventLogAdded },
    entityChanges: [],
    effectResults,
    serverResponse: null,
    screenshotPath: null,
    accepted: true,
    errors: [],
    warnings: [],
  };
}

const failedPersist = (extra?: Partial<EffectTrace>): EffectTrace => ({
  type: 'persist',
  entityName: 'CartItem',
  action: 'create',
  args: [],
  status: 'failed',
  outcome: 'failed',
  error: 'denied by policy',
  ...extra,
});

function schemaWithRoute(failure: string | undefined): OrbitalSchema {
  const emit = failure === undefined ? { success: 'CartItemSaved' } : { success: 'CartItemSaved', failure };
  const orbital: Orbital = {
    name: 'CartOrbital',
    entity: 'CartItem',
    traits: [
      {
        name: 'CartItemPersistor',
        scope: 'instance',
        stateMachine: {
          states: [],
          events: [],
          transitions: [
            {
              from: 'idle',
              event: 'SAVE',
              to: 'saving',
              effects: [['persist', 'create', 'CartItem', { name: '@payload.name' }, { emit }]],
            },
          ],
        },
      },
    ],
    pages: [{ name: 'CartPage', path: '/cart', traits: [{ ref: 'CartItemPersistor' }] }],
  };
  return { name: 'fixture', orbitals: [orbital] };
}

describe('assertEffectFailureNotSurfaced', () => {
  it('returns [] when no frame has a denied/failed effect', () => {
    const frames: Frame[] = [frame(0, persistCause(), [{ type: 'persist', entityName: 'CartItem', args: [], status: 'executed', outcome: 'success' }])];
    expect(assertEffectFailureNotSurfaced(frames, schemaWithRoute('CartItemSaveFailed'))).toEqual([]);
  });

  it('passes: declared failure route fires and a toast mounts', () => {
    const frames: Frame[] = [
      frame(
        0,
        persistCause(),
        [failedPersist()],
        [{ type: 'CartItemSaveFailed', payload: {}, timestamp: 1 }],
        toastDom,
      ),
    ];
    const verdicts = assertEffectFailureNotSurfaced(frames, schemaWithRoute('CartItemSaveFailed'));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(true);
    expect(verdicts[0].detail).toContain('effect-failure-not-surfaced');
  });

  it('flags effect-failure-unrouted when the effect declares no emit.failure', () => {
    const frames: Frame[] = [frame(0, persistCause(), [failedPersist()])];
    const verdicts = assertEffectFailureNotSurfaced(frames, schemaWithRoute(undefined));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toContain('effect-failure-unrouted');
    expect(verdicts[0].detail).toContain('no emit.failure route');
  });

  it('flags effect-failure-unrouted when the declared route never appears in the event log', () => {
    const frames: Frame[] = [frame(0, persistCause(), [failedPersist()])];
    const verdicts = assertEffectFailureNotSurfaced(frames, schemaWithRoute('CartItemSaveFailed'));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toContain('effect-failure-unrouted');
    expect(verdicts[0].detail).toContain('never appeared in the event log');
  });

  it('flags effect-failure-not-surfaced when the route fires but no toast mounts', () => {
    const frames: Frame[] = [
      frame(0, persistCause(), [failedPersist()], [{ type: 'CartItemSaveFailed', payload: {}, timestamp: 1 }]),
    ];
    const verdicts = assertEffectFailureNotSurfaced(frames, schemaWithRoute('CartItemSaveFailed'));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toContain('effect-failure-not-surfaced');
    expect(verdicts[0].detail).toContain('no toast mounted');
  });

  it('credits a toast landing within the forward-scan window, not just the same frame', () => {
    const frames: Frame[] = [
      frame(0, persistCause(), [failedPersist()], [{ type: 'CartItemSaveFailed', payload: {}, timestamp: 1 }]),
      frame(1, { ...persistCause(), traitName: 'ToastHost', from: 'saving', to: 'saving', event: 'CartItemSaveFailed', triggerKind: 'bus' }, [], [], toastDom),
    ];
    const verdicts = assertEffectFailureNotSurfaced(frames, schemaWithRoute('CartItemSaveFailed'));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(true);
  });

  it('is silent on a guard rejection even with a stale denied/failed effectResults entry', () => {
    const frames: Frame[] = [frame(0, persistCause('fail'), [failedPersist()])];
    expect(assertEffectFailureNotSurfaced(frames, schemaWithRoute('CartItemSaveFailed'))).toEqual([]);
  });

  describe('in-place surfaces', () => {
    const failFrame = () =>
      frame(0, persistCause(), [failedPersist()], [{ type: 'CartItemSaveFailed', payload: {}, timestamp: 1 }]);
    const failureHandler = (dom: Frame['domSnapshot']) =>
      frame(
        1,
        { ...persistCause(), traitName: 'CartItemBrowse', from: 'saving', to: 'error', event: 'CartItemSaveFailed', triggerKind: 'bus' },
        [],
        [],
        dom,
      );
    const unrelated = (dom: Frame['domSnapshot']) =>
      frame(
        1,
        { ...persistCause(), traitName: 'Banner', from: 'idle', to: 'idle', event: 'BANNER_SHOWN', triggerKind: 'bus' },
        [],
        [],
        dom,
      );

    it('credits an alert in main rendered by the failure event\'s own transition', () => {
      const v = assertEffectFailureNotSurfaced([failFrame(), failureHandler(mainDom('alert'))], schemaWithRoute('CartItemSaveFailed'));
      expect(v).toHaveLength(1);
      expect(v[0].passed).toBe(true);
      expect(v[0].detail).toContain('alert');
    });

    it('credits error-state in main from the failure transition', () => {
      const v = assertEffectFailureNotSurfaced([failFrame(), failureHandler(mainDom('error-state'))], schemaWithRoute('CartItemSaveFailed'));
      expect(v[0].passed).toBe(true);
    });

    it('control: an alert in main from an UNRELATED transition does not count', () => {
      const v = assertEffectFailureNotSurfaced([failFrame(), unrelated(mainDom('alert'))], schemaWithRoute('CartItemSaveFailed'));
      expect(v).toHaveLength(1);
      expect(v[0].passed).toBe(false);
      expect(v[0].detail).toContain('effect-failure-not-surfaced');
    });

    it('control: a non-alert pattern from the failure transition does not count', () => {
      const v = assertEffectFailureNotSurfaced([failFrame(), failureHandler(mainDom('entity-table'))], schemaWithRoute('CartItemSaveFailed'));
      expect(v[0].passed).toBe(false);
    });

    it('control: a failure-transition frame with no pattern marker does not count', () => {
      const v = assertEffectFailureNotSurfaced([failFrame(), failureHandler(mainDom(undefined))], schemaWithRoute('CartItemSaveFailed'));
      expect(v[0].passed).toBe(false);
    });

    it('control: an unmounted alert portal does not count', () => {
      const dom = { url: '', rowsByEntity: {}, portals: [{ slot: 'main' as const, mounted: false, childCount: 0, pattern: 'alert' }], visibleTextSample: '' };
      const v = assertEffectFailureNotSurfaced([failFrame(), failureHandler(dom)], schemaWithRoute('CartItemSaveFailed'));
      expect(v[0].passed).toBe(false);
    });

    it('control: a guard-rejected failure-event frame does not count', () => {
      const rejected = frame(
        1,
        { ...persistCause('fail'), traitName: 'CartItemBrowse', from: 'saving', to: 'saving', event: 'CartItemSaveFailed', triggerKind: 'bus' },
        [], [], mainDom('alert'),
      );
      const v = assertEffectFailureNotSurfaced([failFrame(), rejected], schemaWithRoute('CartItemSaveFailed'));
      expect(v[0].passed).toBe(false);
    });

    it('a toast still counts; nothing at all still fails', () => {
      const ok = assertEffectFailureNotSurfaced([frame(0, persistCause(), [failedPersist()], [{ type: 'CartItemSaveFailed', payload: {}, timestamp: 1 }], toastDom)], schemaWithRoute('CartItemSaveFailed'));
      expect(ok[0].passed).toBe(true);
      const none = assertEffectFailureNotSurfaced([failFrame(), failureHandler(emptyDom)], schemaWithRoute('CartItemSaveFailed'));
      expect(none[0].passed).toBe(false);
    });

    it('declares exactly the alert-like pattern set', () => {
      expect([...FAILURE_SURFACE_PATTERNS].sort()).toEqual(['alert', 'error-state', 'violation-alert']);
    });
  });
});
