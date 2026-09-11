import { describe, it, expect } from 'vitest';
import type { EventLogEntry, Orbital, OrbitalSchema, VerificationSnapshot } from '@almadar/core';
import { assertEmitPayloadAlwaysEmpty } from '../emit-payload-always-empty.js';
import type { Frame, FrameCause } from '../../frame/types.js';

const emptyDom = { url: '', rowsByEntity: {}, portals: [], visibleTextSample: '' };
const emptySnapshot: VerificationSnapshot = {
  checks: [],
  transitions: [],
  bridge: null,
  summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
  traits: [],
};

const busCause = (event: string): FrameCause => ({
  traitName: 'DirectMessageStarter',
  from: 'idle',
  event,
  to: 'idle',
  guardCase: null,
  triggerKind: 'bus',
  isRepositioning: false,
});

function frame(index: number, eventLogAdded: ReadonlyArray<EventLogEntry>): Frame {
  return {
    index,
    timestamp: 1000 + index,
    cause: busCause('AUTO_OPEN'),
    stateBefore: 'idle',
    stateAfter: 'idle',
    payload: {},
    eventFired: 'AUTO_OPEN',
    runtimeSnapshot: emptySnapshot,
    domSnapshot: emptyDom,
    consoleDelta: { added: [], newErrors: 0, newWarnings: 0 },
    eventLogDelta: { added: eventLogAdded },
    entityChanges: [],
    effectResults: [],
    serverResponse: null,
    screenshotPath: null,
    accepted: true,
    errors: [],
    warnings: [],
  };
}

function schemaWithEmitter(): OrbitalSchema {
  const orbital: Orbital = {
    name: 'ChatOrbital',
    entity: 'ChatMessage',
    traits: [
      {
        name: 'DirectMessageStarter',
        scope: 'instance',
        stateMachine: { states: [], events: [], transitions: [] },
        emits: [
          {
            event: 'CONVERSATION_OPENED',
            scope: 'external',
            payloadSchema: [{ name: 'channel', type: 'string', required: true }],
          },
        ],
      },
    ],
    pages: [{ name: 'ChatPage', path: '/chat', traits: [{ ref: 'DirectMessageStarter' }] }],
  };
  return { name: 'fixture', orbitals: [orbital] };
}

describe('assertEmitPayloadAlwaysEmpty', () => {
  it('flags a declared payload field empty on every firing, fired >= 2 times', () => {
    const frames: Frame[] = [
      frame(0, [{ type: 'CONVERSATION_OPENED', payload: { channel: '' }, timestamp: 1 }]),
      frame(1, [{ type: 'CONVERSATION_OPENED', payload: { channel: '' }, timestamp: 2 }]),
      frame(2, [{ type: 'CONVERSATION_OPENED', payload: { channel: '' }, timestamp: 3 }]),
    ];
    const verdicts = assertEmitPayloadAlwaysEmpty(frames, schemaWithEmitter());
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toContain('DirectMessageStarter');
    expect(verdicts[0].detail).toContain('CONVERSATION_OPENED');
    expect(verdicts[0].detail).toContain('channel');
    expect(verdicts[0].detail).toContain('3 time(s)');
  });

  it('is silent when at least one firing carries a real value', () => {
    const frames: Frame[] = [
      frame(0, [{ type: 'CONVERSATION_OPENED', payload: { channel: '' }, timestamp: 1 }]),
      frame(1, [{ type: 'CONVERSATION_OPENED', payload: { channel: 'general' }, timestamp: 2 }]),
    ];
    expect(assertEmitPayloadAlwaysEmpty(frames, schemaWithEmitter())).toEqual([]);
  });

  it('is silent when the event fired fewer than 2 times', () => {
    const frames: Frame[] = [
      frame(0, [{ type: 'CONVERSATION_OPENED', payload: { channel: '' }, timestamp: 1 }]),
    ];
    expect(assertEmitPayloadAlwaysEmpty(frames, schemaWithEmitter())).toEqual([]);
  });

  it('is silent when the event never fired', () => {
    const frames: Frame[] = [frame(0, [])];
    expect(assertEmitPayloadAlwaysEmpty(frames, schemaWithEmitter())).toEqual([]);
  });

  it('treats undefined and null the same as empty string', () => {
    const frames: Frame[] = [
      frame(0, [{ type: 'CONVERSATION_OPENED', payload: {}, timestamp: 1 }]),
      frame(1, [{ type: 'CONVERSATION_OPENED', payload: { channel: null }, timestamp: 2 }]),
    ];
    const verdicts = assertEmitPayloadAlwaysEmpty(frames, schemaWithEmitter());
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(false);
  });

  it('returns [] when the schema declares no emit payload fields', () => {
    const orbital: Orbital = {
      name: 'ChatOrbital',
      entity: 'ChatMessage',
      traits: [{ name: 'Idle', scope: 'instance', stateMachine: { states: [], events: [], transitions: [] } }],
      pages: [],
    };
    const frames: Frame[] = [
      frame(0, [{ type: 'CONVERSATION_OPENED', payload: { channel: '' }, timestamp: 1 }]),
      frame(1, [{ type: 'CONVERSATION_OPENED', payload: { channel: '' }, timestamp: 2 }]),
    ];
    expect(assertEmitPayloadAlwaysEmpty(frames, { name: 'fixture', orbitals: [orbital] })).toEqual([]);
  });
});
