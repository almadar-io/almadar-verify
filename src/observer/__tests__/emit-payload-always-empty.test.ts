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

  it('flags a REQUIRED field even on a single empty firing — the contract is already broken', () => {
    const frames: Frame[] = [
      frame(0, [{ type: 'CONVERSATION_OPENED', payload: { channel: '' }, timestamp: 1 }]),
    ];
    const verdicts = assertEmitPayloadAlwaysEmpty(frames, schemaWithEmitter());
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].detail).toContain("required field 'channel'");
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

describe('assertEmitPayloadAlwaysEmpty — nested contracts and required fields', () => {
  function composerSchema(): OrbitalSchema {
    return {
      name: 'efficacy-chat',
      version: '1.0.0',
      orbitals: [{
        name: 'ChatMessageOrbital',
        entity: { name: 'ChatMessage', fields: [{ name: 'id', type: 'string', required: true }] },
        pages: [],
        traits: [{
          name: 'ChatComposer',
          scope: 'instance',
          linkedEntity: 'ChatMessage',
          emits: [{
            event: 'SAVE',
            payloadSchema: [{
              name: 'data',
              type: 'object',
              properties: [
                { name: 'content', type: 'string', required: true },
                { name: 'channel', type: 'string', required: true },
                { name: 'attachment', type: 'string' },
              ],
            }],
          }],
          stateMachine: { states: [{ name: 'ready', isInitial: true }], events: [], transitions: [] },
        }],
      }],
    };
  }

  it('flags a REQUIRED nested field empty on its very first firing (chat composer SAVE.data.content)', () => {
    const frames = [frame(0, [{ type: 'SAVE', payload: { data: { content: undefined, channel: 'general' } }, timestamp: 1 }])];
    const verdicts = assertEmitPayloadAlwaysEmpty(frames, composerSchema());
    expect(verdicts.map((v) => v.detail)).toEqual([
      expect.stringContaining("required field 'data.content' was empty"),
    ]);
  });

  it('still needs two firings before an OPTIONAL nested field counts as always empty', () => {
    const once = [frame(0, [{ type: 'SAVE', payload: { data: { content: 'hi', channel: 'general' } }, timestamp: 1 }])];
    expect(assertEmitPayloadAlwaysEmpty(once, composerSchema())).toEqual([]);
    const twice = [
      ...once,
      frame(1, [{ type: 'SAVE', payload: { data: { content: 'again', channel: 'general' } }, timestamp: 2 }]),
    ];
    expect(assertEmitPayloadAlwaysEmpty(twice, composerSchema()).map((v) => v.detail)).toEqual([
      expect.stringContaining("field 'data.attachment' was empty"),
    ]);
  });
});

describe('assertEmitPayloadAlwaysEmpty — a click that carries nothing is decisive for a required field', () => {
  it('flags data.content empty on the DOM-driven firing even though the bus dispatch carried a synthesized value', () => {
    const schema: OrbitalSchema = {
      name: 'efficacy-chat',
      version: '1.0.0',
      orbitals: [{
        name: 'ChatMessageOrbital',
        entity: { name: 'ChatMessage', fields: [{ name: 'id', type: 'string', required: true }] },
        pages: [],
        traits: [{
          name: 'ChatComposer',
          scope: 'instance',
          linkedEntity: 'ChatMessage',
          emits: [{ event: 'SAVE', payloadSchema: [{ name: 'data', type: 'object', properties: [{ name: 'content', type: 'string', required: true }] }] }],
          stateMachine: { states: [{ name: 'ready', isInitial: true }], events: [], transitions: [] },
        }],
      }],
    };
    const busFrame = frame(0, [{ type: 'SAVE', payload: { data: { content: 'timber summit' } }, timestamp: 1 }]);
    const domFrame: Frame = {
      ...frame(1, [{ type: 'SAVE', payload: { data: { content: undefined } }, timestamp: 2 }]),
      cause: { ...busCause('SEND'), triggerKind: 'dom' },
    };
    const verdicts = assertEmitPayloadAlwaysEmpty([busFrame, domFrame], schema);
    expect(verdicts.map((v) => v.detail)).toEqual([
      expect.stringContaining("required field 'data.content' was empty on the firing a real affordance produced"),
    ]);
    expect(assertEmitPayloadAlwaysEmpty([busFrame], schema)).toEqual([]);
  });
});

describe('assertEmitPayloadAlwaysEmpty — server-side emits are read from the response trace', () => {
  it('sees a server-side SAVE whose evaluated payload never reached the client bus log', () => {
    const schema: OrbitalSchema = {
      name: 'efficacy-chat',
      version: '1.0.0',
      orbitals: [{
        name: 'ChatMessageOrbital',
        entity: { name: 'ChatMessage', fields: [{ name: 'id', type: 'string', required: true }] },
        pages: [],
        traits: [{
          name: 'ChatComposer',
          scope: 'instance',
          linkedEntity: 'ChatMessage',
          emits: [{ event: 'SAVE', payloadSchema: [{ name: 'data', type: 'object', properties: [{ name: 'content', type: 'string', required: true }] }] }],
          stateMachine: { states: [{ name: 'ready', isInitial: true }], events: [], transitions: [] },
        }],
      }],
    };
    const domFrame: Frame = {
      ...frame(0, []),
      cause: { ...busCause('SEND'), triggerKind: 'dom' },
      serverResponse: {
        orbitalName: 'ChatMessageOrbital', success: true, transitioned: true, clientEffects: 0, dataEntities: {},
        emittedEvents: ['SAVE'], emitted: [{ event: 'SAVE', payload: { data: { channel: 'general' } } }], timestamp: 1,
      },
    };
    const verdicts = assertEmitPayloadAlwaysEmpty([domFrame], schema);
    expect(verdicts.map((v) => v.detail)).toEqual([expect.stringContaining("required field 'data.content' was empty")]);
  });
});

describe('assertEmitPayloadAlwaysEmpty — entity-typed payload fields are one leaf', () => {
  it('does not walk into `data : [ChatMessage]` (entity marker + entity fields as properties)', () => {
    const schema: OrbitalSchema = {
      name: 'efficacy-chat',
      version: '1.0.0',
      orbitals: [{
        name: 'ChatMessageOrbital',
        entity: { name: 'ChatMessage', fields: [{ name: 'id', type: 'string', required: true }] },
        pages: [],
        traits: [{
          name: 'ChatThreadView',
          scope: 'collection',
          linkedEntity: 'ChatMessage',
          emits: [{ event: 'ChatMessageLoaded', payloadSchema: [{ name: 'data', type: 'array', entity: 'ChatMessage', properties: [{ name: 'id', type: 'string', required: true }, { name: 'content', type: 'string', required: true }] }] }],
          stateMachine: { states: [{ name: 'loading', isInitial: true }], events: [], transitions: [] },
        }],
      }],
    };
    const frames = [frame(0, [{ type: 'ChatMessageLoaded', payload: { data: [{ id: 'ChatMessage Id 1', content: 'hi' }] }, timestamp: 1 }])];
    expect(assertEmitPayloadAlwaysEmpty(frames, schema)).toEqual([]);
  });
});

