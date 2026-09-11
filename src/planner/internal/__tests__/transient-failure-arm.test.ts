import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, SExpr, Transition } from '@almadar/core';
import type { TraitWalkConfig } from '../../../engine/types.js';
import {
  collectFailureEventsAcross,
  deriveDenyingViewer,
  findEnteringPersist,
  isTransientFailureArm,
} from '../transient-failure-arm.js';

/** std-realtime-chat's `DirectMessageStarter` shape (RV item 27): START_DM
 *  (idle -> creating) persists Channel, emitting DmChannelCreateFailed on
 *  failure; `creating`'s own DM_CHANNEL_READY/DM_OPENED self-loop/exit are
 *  ALSO effect-emitted, so `creating` races forward before a manual
 *  dispatch of the failure event could ever land there. */
const transitions: Transition[] = [
  {
    from: 'idle',
    event: 'START_DM',
    to: 'creating',
    guard: ['and', '@payload.id', ['!=', '@payload.id', '@user.id']],
    effects: [
      ['persist', 'create', 'Channel', { id: '@entity.pendingChannelId', isDirect: true, name: '@payload.name' },
        { emit: { failure: 'DmChannelCreateFailed', success: 'DM_CHANNEL_READY' } }],
    ],
  },
  {
    from: 'creating',
    event: 'DM_CHANNEL_READY',
    to: 'creating',
    effects: [
      ['persist', 'create', 'ChannelMember', { channel: '@entity.pendingChannelId', isDirect: true, member: '@user.id' },
        { emit: { failure: 'DmMembershipCreateFailed', success: 'DM_OPENED' } }],
    ],
  },
  { from: 'creating', event: 'DM_OPENED', to: 'idle', effects: [] },
  {
    from: 'creating',
    event: 'DmChannelCreateFailed',
    to: 'idle',
    effects: [['render-ui', 'toast', { type: 'alert', variant: 'error', message: '@payload.error' }]],
  },
  {
    from: 'creating',
    event: 'DmMembershipCreateFailed',
    to: 'idle',
    effects: [['render-ui', 'toast', { type: 'alert', variant: 'error', message: '@payload.error' }]],
  },
];

const walkConfig: TraitWalkConfig = {
  traitName: 'DirectMessageStarter',
  initialState: 'idle',
  transitions: transitions.map((t) => ({ from: t.from as string, event: t.event, to: t.to as string, hasGuard: t.guard !== undefined })),
  effectEmittedEvents: new Set(['DM_CHANNEL_READY', 'DM_OPENED', 'DmChannelCreateFailed', 'DmMembershipCreateFailed']),
};

function schemaWith(overrides: {
  channelCreatePolicy?: SExpr;
  memberCreatePolicy?: SExpr;
  roleVocabulary?: string[];
}): OrbitalSchema {
  return {
    name: 'transient-failure-arm-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'ChannelOrbital',
        entity: {
          name: 'Channel',
          persistence: 'persistent',
          collection: 'channels',
          fields: [{ name: 'id', type: 'string', required: true }],
          ...(overrides.channelCreatePolicy !== undefined && { create_policy: overrides.channelCreatePolicy }),
        },
        auxiliaryEntities: [
          {
            name: 'ChannelMember',
            persistence: 'persistent',
            collection: 'channelmembers',
            fields: [{ name: 'id', type: 'string', required: true }],
            ...(overrides.memberCreatePolicy !== undefined && { create_policy: overrides.memberCreatePolicy }),
          },
          {
            name: 'OnlineUser',
            persistence: 'persistent',
            collection: 'online_users',
            identity: true,
            fields: [
              { name: 'id', type: 'string', required: true },
              { name: 'role', type: 'string', values: overrides.roleVocabulary ?? ['member', 'moderator', 'admin'] },
            ],
          },
        ],
        pages: [],
        traits: [],
      },
    ],
  };
}

describe('isTransientFailureArm', () => {
  it('true for a failure-route arm whose `from` races forward via an effect-emitted sibling', () => {
    expect(isTransientFailureArm('creating', 'DmChannelCreateFailed', transitions, walkConfig)).toBe(true);
    expect(isTransientFailureArm('creating', 'DmMembershipCreateFailed', transitions, walkConfig)).toBe(true);
  });

  it('false for an event that is not a declared failure route', () => {
    expect(isTransientFailureArm('creating', 'DM_OPENED', transitions, walkConfig)).toBe(false);
  });

  it('false when `from` cannot race forward (no effect-emitted outgoing transition)', () => {
    const staticWalkConfig: TraitWalkConfig = { ...walkConfig, effectEmittedEvents: new Set() };
    expect(isTransientFailureArm('creating', 'DmChannelCreateFailed', transitions, staticWalkConfig)).toBe(false);
  });
});

describe('collectFailureEventsAcross', () => {
  it('collects emit.failure across every transition in the trait', () => {
    expect(collectFailureEventsAcross(transitions)).toEqual(new Set(['DmChannelCreateFailed', 'DmMembershipCreateFailed']));
  });
});

describe('findEnteringPersist', () => {
  it('finds the transition whose persist declares emit.failure for the given event', () => {
    const found = findEnteringPersist(transitions, 'DmChannelCreateFailed');
    expect(found?.transition.event).toBe('START_DM');
    expect(found?.entity).toBe('Channel');
    expect(found?.kind).toBe('create');
  });

  it('null when no transition declares that failure event', () => {
    expect(findEnteringPersist(transitions, 'NoSuchFailure')).toBeNull();
  });
});

describe('deriveDenyingViewer', () => {
  it('undefined when the entity declares no policy at all', () => {
    const schema = schemaWith({});
    expect(deriveDenyingViewer(schema, 'Channel', 'create', { isDirect: true })).toBeUndefined();
  });

  it('undefined when the policy is an OR spanning the ENTIRE declared role vocabulary — no role can ever deny it (Channel.@create\'s real shape)', () => {
    const policy: SExpr = ['or', ['=', '@user.role', 'member'], ['=', '@user.role', 'moderator'], ['=', '@user.role', 'admin']];
    const schema = schemaWith({ channelCreatePolicy: policy });
    expect(deriveDenyingViewer(schema, 'Channel', 'create', { isDirect: true })).toBeUndefined();
  });

  it('returns the excluded role when the vocabulary has a role the policy does not accept', () => {
    const policy: SExpr = ['or', ['=', '@user.role', 'moderator'], ['=', '@user.role', 'admin']];
    const schema = schemaWith({ channelCreatePolicy: policy, roleVocabulary: ['member', 'moderator', 'admin'] });
    expect(deriveDenyingViewer(schema, 'Channel', 'create', { isDirect: true })).toEqual({
      role: { field: 'role', value: 'member' },
    });
  });

  it('undefined when a payload-literal OR-term makes the policy unconditionally true regardless of viewer (ChannelMember.@create\'s real "isDirect: true" shape)', () => {
    const policy: SExpr = [
      'or',
      ['=', '@user.role', 'moderator'],
      ['=', '@user.role', 'admin'],
      ['=', ['object/get', '@entity', 'isDirect'], true],
    ];
    const schema = schemaWith({ memberCreatePolicy: policy });
    // Every member of the vocabulary fails the two role clauses, but the
    // literal `isDirect: true` this specific persist's payload carries
    // makes the whole OR true regardless — no role can prove a denial.
    expect(deriveDenyingViewer(schema, 'ChannelMember', 'create', { isDirect: true, member: '@user.id' })).toBeUndefined();
  });

  it('a payload WITHOUT the literal-true field can still be denied — the escape hatch is payload-specific, not entity-wide', () => {
    const policy: SExpr = [
      'or',
      ['=', '@user.role', 'moderator'],
      ['=', '@user.role', 'admin'],
      ['=', ['object/get', '@entity', 'isDirect'], true],
    ];
    const schema = schemaWith({ memberCreatePolicy: policy });
    // No `isDirect` literal in THIS persist's payload — object/get resolves
    // to undefined, `undefined === true` is false, so the role clauses are
    // the only path; 'member' satisfies none of them.
    expect(deriveDenyingViewer(schema, 'ChannelMember', 'create', { member: '@payload.id' })).toEqual({
      role: { field: 'role', value: 'member' },
    });
  });
});
