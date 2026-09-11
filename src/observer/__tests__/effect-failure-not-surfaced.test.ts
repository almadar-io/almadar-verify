import { describe, it, expect } from 'vitest';
import type { EffectTrace, EventLogEntry, Orbital, OrbitalSchema, VerificationSnapshot } from '@almadar/core';
import { assertEffectFailureNotSurfaced } from '../effect-failure-not-surfaced.js';
import type { Frame, FrameCause } from '../../frame/types.js';

const emptyDom = { url: '', rowsByEntity: {}, portals: [], visibleTextSample: '' };
const toastDom = {
  url: '',
  rowsByEntity: {},
  portals: [{ slot: 'toast' as const, mounted: true, childCount: 1 }],
  visibleTextSample: '',
};
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
    expect(verdicts[0].detail).toContain('no toast/alert mounted');
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
});
