import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import type { TraitWalkConfig } from '../../engine/types.js';
import type { PortalExpectation } from '../../observer/types.js';
import { planTransientFailureProbes } from '../plan-transient-failure-probes.js';

/** RV item 27 fixture — std-realtime-chat's `DirectMessageStarter` shape:
 *  `START_DM` (idle -> creating) persists Channel (deniable — role-only
 *  policy over the FULL role vocabulary would be undeniable, so this
 *  fixture narrows the vocabulary to make 'member' a genuine denial);
 *  `creating`'s own DM_CHANNEL_READY persists ChannelMember under a
 *  payload-literal `isDirect: true` OR-term that no viewer can deny. */
const schema: OrbitalSchema = {
  name: 'dm-starter-fixture',
  designTokens: {},
  customPatterns: {},
  orbitals: [
    {
      name: 'DmOrbital',
      entity: {
        name: 'Channel',
        persistence: 'persistent',
        collection: 'channels',
        fields: [{ name: 'id', type: 'string', required: true }],
        create_policy: ['or', ['=', '@user.role', 'moderator'], ['=', '@user.role', 'admin']],
      },
      auxiliaryEntities: [
        {
          name: 'ChannelMember',
          persistence: 'persistent',
          collection: 'channelmembers',
          fields: [{ name: 'id', type: 'string', required: true }],
          create_policy: [
            'or',
            ['=', '@user.role', 'moderator'],
            ['=', '@user.role', 'admin'],
            ['=', ['object/get', '@entity', 'isDirect'], true],
          ],
        },
        {
          name: 'OnlineUser',
          persistence: 'persistent',
          collection: 'online_users',
          identity: true,
          fields: [
            { name: 'id', type: 'string', required: true },
            { name: 'role', type: 'string', values: ['member', 'moderator', 'admin'] },
          ],
        },
      ],
      pages: [],
      traits: [
        {
          name: 'DirectMessageStarter',
          scope: 'instance',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }, { name: 'creating' }],
            events: [
              { key: 'START_DM', name: 'Start DM', payloadSchema: [{ name: 'id', type: 'string', required: true }, { name: 'name', type: 'string', required: true }] },
            ],
            transitions: [
              {
                from: 'idle',
                to: 'creating',
                event: 'START_DM',
                guard: ['and', '@payload.id', ['!=', '@payload.id', '@user.id']],
                effects: [
                  ['persist', 'create', 'Channel', { id: '@entity.pendingChannelId', isDirect: true, name: '@payload.name' },
                    { emit: { failure: 'DmChannelCreateFailed', success: 'DM_CHANNEL_READY' } }],
                ],
              },
              {
                from: 'creating',
                to: 'creating',
                event: 'DM_CHANNEL_READY',
                effects: [
                  ['persist', 'create', 'ChannelMember', { channel: '@entity.pendingChannelId', isDirect: true, member: '@user.id' },
                    { emit: { failure: 'DmMembershipCreateFailed', success: 'DM_OPENED' } }],
                ],
              },
              { from: 'creating', to: 'idle', event: 'DM_OPENED', effects: [] },
              {
                from: 'creating',
                to: 'idle',
                event: 'DmChannelCreateFailed',
                effects: [['render-ui', 'toast', { type: 'alert', variant: 'error', message: '@payload.error' }]],
              },
              {
                from: 'creating',
                to: 'idle',
                event: 'DmMembershipCreateFailed',
                effects: [['render-ui', 'toast', { type: 'alert', variant: 'error', message: '@payload.error' }]],
              },
            ],
          },
        },
      ],
    },
  ],
};

const walkConfig: TraitWalkConfig = {
  traitName: 'DirectMessageStarter',
  initialState: 'idle',
  transitions: [
    { from: 'idle', event: 'START_DM', to: 'creating', hasGuard: true },
    { from: 'creating', event: 'DM_CHANNEL_READY', to: 'creating', hasGuard: false },
    { from: 'creating', event: 'DM_OPENED', to: 'idle', hasGuard: false },
    { from: 'creating', event: 'DmChannelCreateFailed', to: 'idle', hasGuard: false },
    { from: 'creating', event: 'DmMembershipCreateFailed', to: 'idle', hasGuard: false },
  ],
  events: [{ key: 'START_DM', name: 'Start DM', payloadSchema: [{ name: 'id', type: 'string', required: true }, { name: 'name', type: 'string', required: true }] }],
  effectEmittedEvents: new Set(['DM_CHANNEL_READY', 'DM_OPENED', 'DmChannelCreateFailed', 'DmMembershipCreateFailed']),
};

const portalExpectations: PortalExpectation[] = [
  { traitName: 'DirectMessageStarter', from: 'creating', event: 'DmChannelCreateFailed', to: 'idle', slot: 'toast', pattern: 'alert' },
  { traitName: 'DirectMessageStarter', from: 'creating', event: 'DmMembershipCreateFailed', to: 'idle', slot: 'toast', pattern: 'alert' },
];

describe('planTransientFailureProbes', () => {
  it('plans a forced-failure step for the deniable arm (Channel.@create — role-only policy)', () => {
    const { steps } = planTransientFailureProbes(schema, portalExpectations, new Map([['DirectMessageStarter', walkConfig]]));
    const channelStep = steps.find((s) => s.verifiesPortalFor?.event === 'DmChannelCreateFailed');
    expect(channelStep).toBeDefined();
    expect(channelStep?.from).toBe('idle');
    expect(channelStep?.event).toBe('START_DM');
    expect(channelStep?.to).toBe('creating');
    expect(channelStep?.viewerRequirement).toEqual({ role: { field: 'role', value: 'member' } });
    expect(channelStep?.verifiesPortalFor).toEqual({
      traitName: 'DirectMessageStarter', from: 'creating', event: 'DmChannelCreateFailed', to: 'idle',
    });
    // The guard on START_DM must be satisfied (?id truthy, != @user.id).
    expect(channelStep?.payload['id']).toBeDefined();
    expect(channelStep?.payload['id']).not.toBe('');
  });

  it('reports a finding, no step, for the undeniable arm (ChannelMember.@create — isDirect: true always wins)', () => {
    const { steps, findings } = planTransientFailureProbes(schema, portalExpectations, new Map([['DirectMessageStarter', walkConfig]]));
    expect(steps.find((s) => s.verifiesPortalFor?.event === 'DmMembershipCreateFailed')).toBeUndefined();
    const finding = findings.find((f) => f.event === 'DmMembershipCreateFailed');
    expect(finding).toBeDefined();
    expect(finding?.traitName).toBe('DirectMessageStarter');
    expect(finding?.from).toBe('creating');
    expect(finding?.to).toBe('idle');
    expect(finding?.reason).toMatch(/no viewer denies/);
  });

  it('is a no-op for a non-transient portal expectation (an ordinary boot render)', () => {
    const bootExpectations: PortalExpectation[] = [
      { traitName: 'DirectMessageStarter', from: 'idle', event: 'INIT', to: 'idle', slot: 'main', pattern: 'stack' },
    ];
    const { steps, findings } = planTransientFailureProbes(schema, bootExpectations, new Map([['DirectMessageStarter', walkConfig]]));
    expect(steps).toEqual([]);
    expect(findings).toEqual([]);
  });
});
