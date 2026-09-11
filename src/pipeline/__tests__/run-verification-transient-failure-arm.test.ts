/**
 * RV item 27 — pipeline wiring: `runVerification` plans a forced-failure
 * probe for a transient failure-route arm (`DirectMessageStarter`'s
 * `creating + DmChannelCreateFailed -> idle`, unreachable by a plain
 * manual dispatch since `creating` races forward via its own
 * effect-emitted success chain), dispatches it under the denying persona,
 * and reports the SIBLING arm (`DmMembershipCreateFailed`, undeniable —
 * ChannelMember's policy carries a payload-literal `isDirect: true`
 * OR-term) as `transientArmUnreachable`, never a false portal failure.
 *
 * `FakeDriver.snapshot().transitions` is always `[]` (documented
 * limitation, see `driver/impls/fake.ts`), so the PORTAL pass/fail leg
 * itself is unit-tested directly against hand-built frames in
 * `assert-portal-per-step.test.ts` — this test proves the surrounding
 * WIRING: the probe step is planned, dispatched under the derived
 * denying role, and the undeniable sibling is reported as a finding
 * rather than silently asserted against an unreachable dispatch.
 */
import { describe, it, expect } from 'vitest';
import type { EffectTrace, EventPayload, OrbitalSchema, Trait } from '@almadar/core';
import { runVerification } from '../run-verification.js';
import { createFakeDriver } from '../../driver/impls/fake.js';

function dmStarterOrbital(): OrbitalSchema {
  const starter: Trait = {
    name: 'DirectMessageStarter',
    scope: 'instance',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }, { name: 'creating' }],
      events: [
        {
          key: 'START_DM', name: 'Start DM',
          payloadSchema: [{ name: 'id', type: 'string', required: true }, { name: 'name', type: 'string', required: true }],
        },
      ],
      transitions: [
        { from: 'idle', to: 'idle', event: 'INIT' },
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
  };

  return {
    name: 'dm-starter-pipeline-fixture',
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
        pages: [{ name: 'ChatPage', path: '/chat', traits: [{ ref: 'DirectMessageStarter' }] }],
        traits: [starter],
      },
    ],
  };
}

const baseOptions = {
  enableInteractionTests: false,
  enableContractEvents: false,
  enableDataMutationTests: false,
  enableClickPathSamples: false,
  enablePortalPerStep: true,
  enableUserCrudFlow: false,
  enableTickTests: false,
  enableEmitSweep: false,
  log: () => {},
};

describe('runVerification — transient failure-route arm (RV item 27)', () => {
  it('dispatches the entering transition under the denying role, and reports the undeniable sibling as transientArmUnreachable', async () => {
    const orbital = dmStarterOrbital();
    const { extractTraitWalkConfigs } = await import('../../planner/extract-trait-walk-configs.js');
    const traits = extractTraitWalkConfigs(orbital);

    const { driver, runtime } = createFakeDriver(traits, {
      executeEffects: (effects, { persona }) => {
        const traces: EffectTrace[] = [];
        const emitted: Array<{ event: string; payload?: EventPayload }> = [];
        for (const effect of effects) {
          if (!Array.isArray(effect) || effect[0] !== 'persist') continue;
          const entity = effect[2];
          if (entity === 'Channel') {
            const role = persona?.['role'];
            const allowed = role === 'moderator' || role === 'admin';
            traces.push({
              type: 'persist', entityName: 'Channel', action: 'create', args: [],
              status: allowed ? 'executed' : 'failed',
              outcome: allowed ? 'success' : 'denied',
              ...(!allowed && { error: 'denied by access policy (Channel create)' }),
            });
            if (!allowed) {
              // Mirror a real denial's cascade: the trait never leaves
              // `creating` via the success arm, but the failure arm fires
              // and lands it at `idle` for real.
              runtime.setState('DirectMessageStarter', 'idle');
              emitted.push({ event: 'DmChannelCreateFailed', payload: { error: 'denied', code: 'access-denied' } });
            }
          }
        }
        return { effects: traces, emitted };
      },
    });

    const result = await runVerification({
      itemName: 'dm-starter-pipeline-fixture',
      orbital,
      driver,
      ctx: { outputDir: '', runtime },
      options: baseOptions,
    });

    // The probe dispatches the ENTERING transition (START_DM), not the
    // failure event directly — that's the whole point: the failure event
    // is never manually injected, it's the real cascade's own doing.
    const probeFrame = result.frames.find(
      (f) => f.cause.event === 'START_DM' && f.cause.verifiesPortalFor?.event === 'DmChannelCreateFailed',
    );
    expect(probeFrame).toBeDefined();
    expect(probeFrame?.cause.verifiesPortalFor).toEqual({
      traitName: 'DirectMessageStarter', from: 'creating', event: 'DmChannelCreateFailed', to: 'idle',
    });
    const persistTrace = probeFrame?.effectResults.find((e) => e.type === 'persist' && e.entityName === 'Channel');
    expect(persistTrace?.outcome).toBe('denied');

    // The undeniable sibling (ChannelMember.@create's `isDirect: true`
    // escape hatch) never gets a probe step — no false portal failure,
    // an honest informational finding instead.
    const membershipProbeFrame = result.frames.find(
      (f) => f.cause.verifiesPortalFor?.event === 'DmMembershipCreateFailed',
    );
    expect(membershipProbeFrame).toBeUndefined();
    expect(result.verdicts.transientArmUnreachable?.passed).toBe(true);
    expect(result.verdicts.transientArmUnreachable?.detail).toMatch(/DmMembershipCreateFailed/);
  });
});
