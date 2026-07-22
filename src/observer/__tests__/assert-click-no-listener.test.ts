import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, TraitStateSnapshot, VerificationSnapshot } from '@almadar/core';
import { assertClickNoListener } from '../assert-click-no-listener.js';
import type { Frame, FrameCause } from '../../frame/types.js';

const emptyDom = { url: '', rowsByEntity: {}, portals: [], visibleTextSample: '' };

function snapshot(traits: ReadonlyArray<{ name: string; state: string }>): VerificationSnapshot {
  const traitSnapshots: TraitStateSnapshot[] = traits.map((t) => ({
    traitName: t.name,
    currentState: t.state,
    states: ['a', 'b'],
    events: ['GO'],
    data: {},
    cascadeReceived: [], // compiled snapshot never populates this
  }));
  return {
    checks: [],
    transitions: [],
    bridge: null,
    summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
    traits: traitSnapshots,
  };
}

function frame(index: number, cause: FrameCause, traits: ReadonlyArray<{ name: string; state: string }>): Frame {
  return {
    index,
    timestamp: 1000 + index,
    cause,
    stateBefore: cause.from,
    stateAfter: cause.to,
    payload: {},
    eventFired: cause.event,
    runtimeSnapshot: snapshot(traits),
    domSnapshot: emptyDom,
    consoleDelta: { added: [], newErrors: 0, newWarnings: 0 },
    eventLogDelta: { added: [] },
    entityChanges: [],
    effectResults: [],
    serverResponse: null,
    screenshotPath: null,
    accepted: true,
    errors: [],
    warnings: [],
  };
}

const domCause = (traitName: string, event: string): FrameCause => ({
  traitName,
  from: 'browsing',
  event,
  to: 'browsing',
  guardCase: null,
  triggerKind: 'dom',
  isRepositioning: false,
  testKind: 'click-path',
});

// Browse emits ADD_ITEM (no self-transition on it); Modal listens for it from Browse.
const orbital = {
  orbitals: [
    {
      traits: [
        {
          name: 'Browse',
          stateMachine: { transitions: [{ from: 'browsing', event: 'INIT', to: 'browsing' }] },
          listens: [],
        },
        {
          name: 'Modal',
          stateMachine: { transitions: [{ from: 'closed', event: 'ADD_ITEM', to: 'open' }] },
          listens: [{ event: 'ADD_ITEM', triggers: 'ADD_ITEM', source: { kind: 'trait', trait: 'Browse' } }],
        },
      ],
    },
  ],
} as unknown as OrbitalSchema;

describe('assertClickNoListener', () => {
  it('credits a declared cross-trait listener even when cascadeReceived is empty (compiled path)', () => {
    const frames: Frame[] = [
      frame(0, domCause('Browse', 'INIT'), [{ name: 'Browse', state: 'browsing' }, { name: 'Modal', state: 'closed' }]),
      frame(1, domCause('Browse', 'ADD_ITEM'), [{ name: 'Browse', state: 'browsing' }, { name: 'Modal', state: 'closed' }]),
    ];
    expect(assertClickNoListener(frames, orbital)).toEqual([]);
  });

  it('flags a dead button — emits an event no trait handles or subscribes to', () => {
    const frames: Frame[] = [
      frame(0, domCause('Browse', 'INIT'), [{ name: 'Browse', state: 'browsing' }, { name: 'Modal', state: 'closed' }]),
      frame(1, domCause('Browse', 'NOPE'), [{ name: 'Browse', state: 'browsing' }, { name: 'Modal', state: 'closed' }]),
    ];
    const verdicts = assertClickNoListener(frames, orbital);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toContain('NOPE');
  });

  it('credits embedded chrome whose embedding host handles the event (embed-chain delivery)', () => {
    // CloseBtn is chrome embedded in View's render (`@trait.CloseBtn`); its
    // CLOSE emit is delivered under View's scope by the runtime's embed
    // routing — View's own transition is the wiring, no bus subscription on
    // CloseBtn's key ever exists.
    const embedOrbital = {
      orbitals: [{
        traits: [
          {
            name: 'View',
            stateMachine: { transitions: [{ from: 'open', event: 'CLOSE', to: 'closed', effects: [['render-ui', 'main', { children: '@trait.CloseBtn' }]] }] },
            listens: [],
          },
          { name: 'CloseBtn', stateMachine: { transitions: [{ from: 'idle', event: 'INIT', to: 'idle' }] }, listens: [] },
        ],
      }],
    } as unknown as OrbitalSchema;
    const frames: Frame[] = [
      frame(0, domCause('View', 'INIT'), [{ name: 'View', state: 'open' }, { name: 'CloseBtn', state: 'idle' }]),
      frame(1, domCause('CloseBtn', 'CLOSE'), [{ name: 'View', state: 'open' }, { name: 'CloseBtn', state: 'idle' }]),
    ];
    expect(assertClickNoListener(frames, embedOrbital)).toEqual([]);
  });

  it('still flags embedded chrome whose whole embed chain has no handler', () => {
    const embedOrbital = {
      orbitals: [{
        traits: [
          {
            name: 'View',
            stateMachine: { transitions: [{ from: 'open', event: 'INIT', to: 'open', effects: [['render-ui', 'main', { children: '@trait.DeadBtn' }]] }] },
            listens: [],
          },
          { name: 'DeadBtn', stateMachine: { transitions: [{ from: 'idle', event: 'INIT', to: 'idle' }] }, listens: [] },
        ],
      }],
    } as unknown as OrbitalSchema;
    const frames: Frame[] = [
      frame(0, domCause('View', 'INIT'), [{ name: 'View', state: 'open' }, { name: 'DeadBtn', state: 'idle' }]),
      frame(1, domCause('DeadBtn', 'NOPE'), [{ name: 'View', state: 'open' }, { name: 'DeadBtn', state: 'idle' }]),
    ];
    const verdicts = assertClickNoListener(frames, embedOrbital);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].detail).toContain('embed-chain: no');
  });

  it('credits self-targeting (the emitting trait handles the event itself)', () => {
    const selfOrbital = {
      orbitals: [{ traits: [{ name: 'Browse', stateMachine: { transitions: [{ from: 'browsing', event: 'GO', to: 'browsing' }] }, listens: [] }] }],
    } as unknown as OrbitalSchema;
    const frames: Frame[] = [
      frame(0, domCause('Browse', 'INIT'), [{ name: 'Browse', state: 'browsing' }]),
      frame(1, domCause('Browse', 'GO'), [{ name: 'Browse', state: 'browsing' }]),
    ];
    expect(assertClickNoListener(frames, selfOrbital)).toEqual([]);
  });
});
