import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { assertListensEdgeNeverFired } from '../listens-edge-never-fired.js';
import type { Frame, FrameCause } from '../../frame/types.js';

function schemaWith(): OrbitalSchema {
  return {
    name: 'listens-edge-fixture',
    orbitals: [
      {
        name: 'Orb',
        entity: { name: 'Item', fields: [{ name: 'id', type: 'string', required: true }] },
        pages: [],
        traits: [
          {
            name: 'Source',
            scope: 'instance',
            stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
          },
          {
            name: 'Listener',
            scope: 'instance',
            listens: [{ event: 'SOURCE_FIRED', triggers: 'LOCAL_HANDLE', source: { kind: 'trait', trait: 'Source' } }],
            stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
          },
        ],
      },
    ],
  };
}

const cause = (event: string): FrameCause => ({
  traitName: 'Source', from: 'idle', event, to: 'idle', guardCase: null, triggerKind: 'bus', isRepositioning: false,
});

function frame(index: number, event: string, opts: { runtimeTx?: Array<{ traitName: string; event: string }> } = {}): Frame {
  return {
    index,
    timestamp: 1000 + index,
    cause: cause(event),
    stateBefore: 'idle',
    stateAfter: 'idle',
    payload: {},
    eventFired: event,
    runtimeSnapshot: {
      checks: [], bridge: null, summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 }, traits: [],
      transitions: (opts.runtimeTx ?? []).map((t, i) => ({
        id: `tx-${index}-${i}`, traitName: t.traitName, from: 'idle', to: 'idle', event: t.event, effects: [], timestamp: 1000 + index,
      })),
    },
    domSnapshot: { url: '', rowsByEntity: {}, portals: [], visibleTextSample: '' },
    consoleDelta: { added: [], newErrors: 0, newWarnings: 0 },
    eventLogDelta: { added: [{ type: event, timestamp: 1000 + index }] },
    entityChanges: [],
    effectResults: [],
    serverResponse: null,
    screenshotPath: null,
    accepted: true,
    errors: [],
    warnings: [],
  };
}

describe('assertListensEdgeNeverFired', () => {
  it('returns [] when the schema declares no listens routes', () => {
    const schema: OrbitalSchema = { name: 'empty', orbitals: [{ name: 'Orb', entity: { name: 'Item', fields: [] }, pages: [], traits: [] }] };
    expect(assertListensEdgeNeverFired([], schema)).toEqual([]);
  });

  it('silent when the source fired fewer than 2 times', () => {
    const schema = schemaWith();
    const frames = [frame(0, 'SOURCE_FIRED')];
    expect(assertListensEdgeNeverFired(frames, schema)).toEqual([]);
  });

  it('flags a route whose source fired >=2 times but the listener\'s own trigger never observed firing', () => {
    const schema = schemaWith();
    const frames = [frame(0, 'SOURCE_FIRED'), frame(1, 'SOURCE_FIRED')];
    const verdicts = assertListensEdgeNeverFired(frames, schema);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/listens-edge-never-fired/);
    expect(verdicts[0].detail).toMatch(/Listener listens 'SOURCE_FIRED' -> 'LOCAL_HANDLE'/);
  });

  it('silent once the listener\'s own trigger is observed firing', () => {
    const schema = schemaWith();
    const frames = [
      frame(0, 'SOURCE_FIRED'),
      frame(1, 'SOURCE_FIRED', { runtimeTx: [{ traitName: 'Listener', event: 'LOCAL_HANDLE' }] }),
    ];
    expect(assertListensEdgeNeverFired(frames, schema)).toEqual([]);
  });
});
