/**
 * `probeListenCascades` — live runtime probe over `OrbitalServerRuntime`.
 *
 * Two synthetic fixtures (in-process, no CLI) cover the probe's own logic:
 *   1. a working cascade (source emits, listener's own transition fires) —
 *      0 findings.
 *   2. a listener whose declared source never emits the listened-for event
 *      at all — 1 `listen-source-cannot-emit` finding.
 *
 * The third block runs the probe against the REAL resolved `vim-mode`
 * plugin (`orbital resolve`), the exact schema
 * `packages/almadar-runtime/test/composed-trait-listen-eventid-routing.test.ts`
 * regression-tests directly against `OrbitalServerRuntime`. With
 * `@almadar/runtime` HEAD (the `resolveSourceEmitEventId` fix) the probe
 * reports 0 findings — end-to-end confirmation that the fix this rung was
 * built to catch actually holds. The negative control mutates the ONE field
 * the bug was about (`VimStudioBridge`'s `listens { Shell.PLUGIN_ENABLED ->
 * ENABLED }` entry carries no `eventId` of its own — see
 * `OrbitalServerRuntime.resolveSourceEmitEventId`'s doc comment): stamping a
 * WRONG explicit `eventId` on that listen bypasses the fix path entirely
 * (`listener.eventId ?? resolveSourceEmitEventId(...)` short-circuits on the
 * listener's own, now-wrong, value) — the exact "two different bus keys for
 * the same logical event" shape the pre-fix code produced for every
 * composed trait whose listen hadn't been id-stamped yet. The probe reports
 * `listen-cascade-not-delivered` for it, proving the check actually catches
 * the regression it exists to prevent (not just green on a fixture that
 * happens to pass).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import type { OrbitalSchema, SExpr, TraitEventListener } from '@almadar/core';
import { asEventId } from '@almadar/core';
import { OrbitalServerRuntime } from '@almadar/runtime/OrbitalServerRuntime';
import { InMemoryPersistence } from '@almadar/runtime';
import { probeListenCascades } from '../probe-listen-cascades.js';

/** Owner-scoped by-id-fetch fixture shared by the two `persistence` seeding
 *  tests below (item B): `Source` fetches `Widget` BY ID on `INIT`, guarded
 *  on a non-empty `?id` — the exact `std-record-detail` shape
 *  (`Almadar_LOLO.md`'s `RecordItemDetail`) whose synthesized id used to
 *  miss every seeded row. `Widget`'s `read_policy` scopes reads to the
 *  viewer that owns the row, so this fixture ALSO exercises the
 *  owner-column stamping fix — an unstamped seed row fails this policy and
 *  reports "not found" exactly like a genuinely missing row would. */
function ownerScopedFetchApp(listenEventId?: string): OrbitalSchema {
  return {
    name: 'DetailApp',
    orbitals: [
      {
        name: 'DetailOrbital',
        entity: {
          name: 'Widget',
          persistence: 'runtime',
          read_policy: ['=', '@entity.ownerId', '@user.id'],
          fields: [
            { name: 'id', type: 'string' },
            { name: 'ownerId', type: 'relation', relation: { entity: 'Person' } },
          ],
        },
        traits: [
          {
            name: 'Source',
            scope: 'instance',
            linkedEntity: 'Widget',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'loading' }],
              events: [{ key: 'INIT', name: 'Init', payloadSchema: [{ name: 'id', type: 'string' }] }],
              transitions: [
                {
                  from: 'idle',
                  to: 'loading',
                  event: 'INIT',
                  guard: ['!=', ['str/default', '@payload.id', ''], ''],
                  effects: [
                    ['fetch', 'Widget', { id: '@payload.id', emit: { success: 'WidgetLoaded', failure: 'WidgetLoadFailed' } }],
                  ],
                },
              ],
            },
            emits: [
              { event: 'WidgetLoaded', scope: 'external' },
              { event: 'WidgetLoadFailed', scope: 'external' },
            ],
          },
          {
            name: 'Listener',
            scope: 'instance',
            linkedEntity: 'Widget',
            stateMachine: {
              states: [{ name: 'active', isInitial: true }],
              events: [{ key: 'RECEIVED', name: 'Received' }],
              transitions: [{ from: 'active', to: 'active', event: 'RECEIVED', effects: [['emit', 'DONE', {}]] }],
            },
            emits: [{ event: 'DONE', scope: 'external' }],
            listens: [
              {
                event: 'WidgetLoaded',
                triggers: 'RECEIVED',
                scope: 'external',
                source: { kind: 'trait', trait: 'Source' },
                ...(listenEventId === undefined ? {} : { eventId: asEventId(listenEventId) }),
              },
            ],
          },
        ],
        pages: [],
      },
      // `ownerFieldsFromSchema` only credits `Widget.ownerId` as an owner
      // column once SOME entity in the schema is tagged `[identity]` — the
      // schema-wide gate `identityEntityNames` checks before scanning any
      // relation field at all.
      {
        name: 'PersonOrbital',
        entity: { name: 'Person', identity: true, persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [],
        pages: [],
      },
    ],
  };
}

/**
 * Whole-row `persist update` fixture (item B4-V4, residual off
 * `std-notes`' `NotePersistor.DO_UPDATE`): the transition writes
 * `(persist update Item @payload.data {...})`, and `data`'s declared
 * payload schema is `type: object` + `properties` WITH NO `entity` marker
 * — exactly what `orbital-compiler`'s `resolve_sentinel_fields` produces
 * when resolving a payload field typed with the `@entity` self-reference
 * sigil (`data : @entity!` in `.lolo`, the real `std-note.lolo` shape):
 * `field_type`/`properties` get set, `PayloadField.entity` never does
 * (unlike the lowering-time stamp for a literal `row: Item` annotation).
 * `Item`'s owner-scoped `update_policy` means a payload whose `id`/`authorId`
 * are the probe's own random synthesis matches no real row and is denied —
 * this is the live failure `probeListenCascades` was reporting for
 * `NoteBrowseList`/`NoteFavoritesList`/`NoteDoc` (`listen-source-cannot-emit
 * … did not emit NOTE_UPDATED (guard rejected the synthesized payload)`)
 * until `findPersistWholeRowField` patched the seeded row's identity onto
 * the dispatched payload's whole-row field.
 */
function wholeRowPersistUpdateApp(): OrbitalSchema {
  return {
    name: 'ItemApp',
    orbitals: [
      {
        name: 'ItemOrbital',
        entity: {
          name: 'Item',
          persistence: 'runtime',
          update_policy: ['=', ['object/get', '@entity', 'authorId'], '@user.id'],
          fields: [
            { name: 'id', type: 'string' },
            { name: 'authorId', type: 'relation', relation: { entity: 'Person' } },
            { name: 'title', type: 'string' },
          ],
        },
        traits: [
          {
            name: 'Persistor',
            scope: 'instance',
            linkedEntity: 'Item',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [
                {
                  key: 'DO_UPDATE',
                  name: 'Do Update',
                  payloadSchema: [
                    {
                      name: 'data',
                      type: 'object',
                      required: true,
                      properties: [
                        { name: 'id', type: 'string', required: true },
                        { name: 'authorId', type: 'relation' },
                        { name: 'title', type: 'string', required: true },
                      ],
                    },
                  ],
                },
              ],
              transitions: [
                {
                  from: 'idle',
                  to: 'idle',
                  event: 'DO_UPDATE',
                  effects: [
                    ['persist', 'update', 'Item', '@payload.data', { emit: { success: 'ITEM_UPDATED' } }],
                  ],
                },
              ],
            },
            emits: [{ event: 'ITEM_UPDATED', scope: 'external' }],
          },
          {
            name: 'Listener',
            scope: 'instance',
            linkedEntity: 'Item',
            stateMachine: {
              states: [{ name: 'active', isInitial: true }],
              events: [{ key: 'RECEIVED', name: 'Received' }],
              transitions: [{ from: 'active', to: 'active', event: 'RECEIVED', effects: [['emit', 'DONE', {}]] }],
            },
            emits: [{ event: 'DONE', scope: 'external' }],
            listens: [
              {
                event: 'ITEM_UPDATED',
                triggers: 'RECEIVED',
                scope: 'external',
                source: { kind: 'trait', trait: 'Persistor' },
              },
            ],
          },
        ],
        pages: [],
      },
      // Same identity-tagging requirement as `ownerScopedFetchApp` above:
      // `ownerFieldsFromSchema` only credits `Item.authorId` as an owner
      // column once SOME entity in the schema is `[identity]`.
      {
        name: 'PersonOrbital',
        entity: { name: 'Person', identity: true, persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [],
        pages: [],
      },
    ],
  };
}

describe('probeListenCascades — persist whole-row payload with no PayloadField.entity marker (B4-V4)', () => {
  it('patches the seeded row identity onto a DO_UPDATE whole-row field and reports 0 findings', async () => {
    const schema = wholeRowPersistUpdateApp();
    const persistence = new InMemoryPersistence();
    const runtime = new OrbitalServerRuntime({ debug: false, persistence });
    await runtime.register(schema);

    const result = await probeListenCascades(runtime, schema, persistence);
    expect(result.probed).toBe(1);
    expect(result.findings).toEqual([]);
  });
});

/**
 * Role-only persist-create fixture (B4-V5, off `std-time-tracking`'s real
 * `Employee [identity] { @create ["=", @user.role, "approver"] }` shape —
 * no owner column, the access check is purely `@user.role`). The probe's
 * own default viewer carries a deliberately EMPTY `role` (`DEFAULT_VIEWER`,
 * `@almadar/core`'s doc), so dispatching unchanged denies the persist
 * before it ever emits — `roleSatisfyingPolicy` must derive a role from the
 * policy's OWN literal, intersected with `Employee.role`'s declared
 * vocabulary, and the probe must switch the dispatch to it.
 */
function roleOnlyPersistCreateApp(createPolicy: SExpr): OrbitalSchema {
  return {
    name: 'EmployeeApp',
    orbitals: [
      {
        name: 'EmployeeOrbital',
        entity: {
          name: 'Employee',
          identity: true,
          persistence: 'runtime',
          create_policy: createPolicy,
          fields: [
            { name: 'id', type: 'string' },
            { name: 'name', type: 'string' },
            { name: 'role', type: 'string', values: ['employee', 'approver'] },
          ],
        },
        traits: [
          {
            name: 'Persistor',
            scope: 'instance',
            linkedEntity: 'Employee',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [
                {
                  key: 'DO_CREATE',
                  name: 'Do Create',
                  payloadSchema: [
                    {
                      name: 'data',
                      type: 'object',
                      required: true,
                      properties: [
                        { name: 'id', type: 'string', required: true },
                        { name: 'name', type: 'string', required: true },
                      ],
                    },
                  ],
                },
              ],
              transitions: [
                {
                  from: 'idle',
                  to: 'idle',
                  event: 'DO_CREATE',
                  effects: [
                    ['persist', 'create', 'Employee', '@payload.data', { emit: { success: 'EMPLOYEE_CREATED' } }],
                  ],
                },
              ],
            },
            emits: [{ event: 'EMPLOYEE_CREATED', scope: 'external' }],
          },
          {
            name: 'Listener',
            scope: 'instance',
            linkedEntity: 'Employee',
            stateMachine: {
              states: [{ name: 'active', isInitial: true }],
              events: [{ key: 'RECEIVED', name: 'Received' }],
              transitions: [{ from: 'active', to: 'active', event: 'RECEIVED', effects: [['emit', 'DONE', {}]] }],
            },
            emits: [{ event: 'DONE', scope: 'external' }],
            listens: [
              {
                event: 'EMPLOYEE_CREATED',
                triggers: 'RECEIVED',
                scope: 'external',
                source: { kind: 'trait', trait: 'Persistor' },
              },
            ],
          },
        ],
        pages: [],
      },
    ],
  };
}

describe('probeListenCascades — role-only persist policy (B4-V5)', () => {
  it('synthesizes an approver viewer for the dispatch and reports 0 findings', async () => {
    const schema = roleOnlyPersistCreateApp(['=', '@user.role', 'approver']);
    const persistence = new InMemoryPersistence();
    const runtime = new OrbitalServerRuntime({ debug: false, persistence });
    await runtime.register(schema);

    const result = await probeListenCascades(runtime, schema, persistence);
    expect(result.probed).toBe(1);
    expect(result.findings).toEqual([]);
    // The role switch is scoped to the one dispatch it was synthesized for —
    // the runtime's own default viewer is left exactly as the probe found
    // it (DEFAULT_VIEWER's deliberately empty role).
    expect(runtime.getDefaultUser()?.role).toBe('');
  });

  it('a policy accepting no roster role is reported, never forced green', async () => {
    // "owner" is not a declared member of `Employee.role`'s vocabulary
    // (`["employee", "approver"]`) — structurally no roster member can ever
    // satisfy this policy, so `roleSatisfyingPolicy` must return `undefined`
    // and the probe must report the honest denial, not synthesize past it.
    const schema = roleOnlyPersistCreateApp(['=', '@user.role', 'owner']);
    const persistence = new InMemoryPersistence();
    const runtime = new OrbitalServerRuntime({ debug: false, persistence });
    await runtime.register(schema);

    const result = await probeListenCascades(runtime, schema, persistence);
    expect(result.probed).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.check).toBe('listen-source-cannot-emit');
  });

  it('C1-V19 (item 5a): reports "denied by access policy", never the old blind "guard rejected" text — this fixture\'s transition declares NO guard at all', async () => {
    const schema = roleOnlyPersistCreateApp(['=', '@user.role', 'owner']);
    const persistence = new InMemoryPersistence();
    const runtime = new OrbitalServerRuntime({ debug: false, persistence });
    await runtime.register(schema);

    const result = await probeListenCascades(runtime, schema, persistence);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.message).toContain('denied by access policy');
    expect(result.findings[0]?.message).not.toContain('guard rejected');
  });
});

/**
 * C1-V19 (item 5b) — `Channel` has NO self-relation, but `ChannelMember.
 * channel` restrict-relates to it (mirrors std-realtime-chat's real shape,
 * C1-V17's fixture). The probe shares ONE persistence store across every
 * probed listen, so by the time this delete-triggering listen runs the
 * store may already hold a row referencing the entity's "default" seeded
 * id. Before this fix `probeListenCascades` always targeted a fixed
 * synthetic id (`effectiveSeedId`), so a genuinely-avoidable restrict block
 * misreported as `listen-source-cannot-emit` with the misleading old
 * hardcoded guard message. This fixture pre-seeds exactly that shape: two
 * `Channel` rows, one of them (the one carrying the SAME id
 * `effectiveSeedId` would have picked) referenced by a `ChannelMember` row.
 */
function channelDeleteCascadeApp(): OrbitalSchema {
  return {
    name: 'ChannelDeleteApp',
    orbitals: [
      {
        name: 'ChannelOrbital',
        entity: { name: 'Channel', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [
          {
            name: 'Persistor',
            scope: 'instance',
            linkedEntity: 'Channel',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [
                { key: 'DO_DELETE', name: 'Do Delete', payloadSchema: [{ name: 'id', type: 'string', required: true }] },
              ],
              transitions: [
                {
                  from: 'idle',
                  to: 'idle',
                  event: 'DO_DELETE',
                  effects: [['persist', 'delete', 'Channel', '@payload.id', { emit: { success: 'CHANNEL_DELETED' } }]],
                },
              ],
            },
            emits: [{ event: 'CHANNEL_DELETED', scope: 'external' }],
          },
          {
            name: 'Listener',
            scope: 'instance',
            linkedEntity: 'Channel',
            stateMachine: {
              states: [{ name: 'active', isInitial: true }],
              events: [{ key: 'RECEIVED', name: 'Received' }],
              transitions: [{ from: 'active', to: 'active', event: 'RECEIVED', effects: [['emit', 'DONE', {}]] }],
            },
            emits: [{ event: 'DONE', scope: 'external' }],
            listens: [
              { event: 'CHANNEL_DELETED', triggers: 'RECEIVED', scope: 'external', source: { kind: 'trait', trait: 'Persistor' } },
            ],
          },
        ],
        pages: [],
      },
      // `OrbitalServerRuntime.enforceOnDeleteRules` scans each REGISTERED
      // orbital's own PRIMARY entity for a relation field targeting the
      // entity being deleted — an `auxiliaryEntities` member is invisible
      // to that scan, so `ChannelMember` must be its own orbital's primary
      // entity for the restrict rule to actually enforce here.
      {
        name: 'ChannelMemberOrbital',
        entity: {
          name: 'ChannelMember',
          persistence: 'runtime',
          fields: [
            { name: 'id', type: 'string' },
            { name: 'channel', type: 'relation', relation: { entity: 'Channel', cardinality: 'one' } },
          ],
        },
        traits: [],
        pages: [],
      },
    ],
  };
}

describe('probeListenCascades — persist delete picks an unreferenced row across entities (C1-V19 item 5b)', () => {
  it('avoids the row a ChannelMember references and reports 0 findings, never a false restrict denial', async () => {
    const schema = channelDeleteCascadeApp();
    const persistence = new InMemoryPersistence();
    // The id `effectiveSeedId`/the old fixed-seed behavior would have
    // targeted — pre-referenced, so a delete against it is genuinely
    // restrict-blocked. A second, unreferenced row is the only safe pick.
    persistence.seed({
      Channel: [{ id: 'Channel-verify-seed-1' }, { id: 'channel-free' }],
      ChannelMember: [{ id: 'member-1', channel: 'Channel-verify-seed-1' }],
    });
    const runtime = new OrbitalServerRuntime({ debug: false, persistence });
    await runtime.register(schema);

    const result = await probeListenCascades(runtime, schema, persistence);
    expect(result.probed).toBe(1);
    expect(result.findings).toEqual([]);
    // The blocked row must still exist — the picker avoided it, not deleted
    // around the restrict rule some other way.
    expect(await persistence.getById('Channel', 'Channel-verify-seed-1')).not.toBeNull();
    expect(await persistence.getById('Channel', 'channel-free')).toBeNull();
  });

  it('when every row is referenced, reports the honest restrict-rule failure, never the old blind "guard rejected" text', async () => {
    const schema = channelDeleteCascadeApp();
    const persistence = new InMemoryPersistence();
    // Only ONE Channel row exists, and it IS referenced — genuinely no
    // deletable row this run, and this transition declares no guard.
    persistence.seed({
      Channel: [{ id: 'Channel-verify-seed-1' }],
      ChannelMember: [{ id: 'member-1', channel: 'Channel-verify-seed-1' }],
    });
    const runtime = new OrbitalServerRuntime({ debug: false, persistence });
    await runtime.register(schema);

    const result = await probeListenCascades(runtime, schema, persistence);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.message).toContain('restrict');
    expect(result.findings[0]?.message).not.toContain('guard rejected');
  });
});

describe('probeListenCascades — synthetic fixtures', () => {
  it('reports 0 findings when the source emits and the listener\'s cascade fires', async () => {
    const schema: OrbitalSchema = {
      name: 'PingApp',
      orbitals: [
        {
          name: 'PingOrbital',
          entity: { name: 'Ping', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
          traits: [
            {
              name: 'Source',
              scope: 'instance',
              linkedEntity: 'Ping',
              stateMachine: {
                states: [{ name: 'idle', isInitial: true }],
                events: [{ key: 'FIRE', name: 'Fire' }],
                transitions: [{ from: 'idle', to: 'idle', event: 'FIRE', effects: [['emit', 'PING', {}]] }],
              },
              emits: [{ event: 'PING', scope: 'external' }],
            },
            {
              name: 'Listener',
              scope: 'instance',
              linkedEntity: 'Ping',
              stateMachine: {
                states: [{ name: 'active', isInitial: true }],
                events: [{ key: 'TICK', name: 'Tick' }],
                transitions: [{ from: 'active', to: 'active', event: 'TICK', effects: [['emit', 'RECEIVED', {}]] }],
              },
              emits: [{ event: 'RECEIVED', scope: 'external' }],
              listens: [
                { event: 'PING', triggers: 'TICK', scope: 'external', source: { kind: 'trait', trait: 'Source' } },
              ],
            },
          ],
          pages: [],
        },
      ],
    };

    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(schema);

    const result = await probeListenCascades(runtime, schema);
    expect(result.probed).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it('reports listen-source-cannot-emit when the declared source never emits the event', async () => {
    const schema: OrbitalSchema = {
      name: 'DeadWireApp',
      orbitals: [
        {
          name: 'DeadWireOrbital',
          entity: { name: 'Ping', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
          traits: [
            {
              // Declares FIRE, but no effect anywhere emits PING — the
              // std-cicd wrong-source-listener class `listens-source-never-
              // emits` already catches statically; the probe should agree.
              name: 'Source',
              scope: 'instance',
              linkedEntity: 'Ping',
              stateMachine: {
                states: [{ name: 'idle', isInitial: true }],
                events: [{ key: 'FIRE', name: 'Fire' }],
                transitions: [{ from: 'idle', to: 'idle', event: 'FIRE', effects: [['set', '@entity.id', '@payload.id']] }],
              },
            },
            {
              name: 'Listener',
              scope: 'instance',
              linkedEntity: 'Ping',
              stateMachine: {
                states: [{ name: 'active', isInitial: true }],
                events: [{ key: 'TICK', name: 'Tick' }],
                transitions: [{ from: 'active', to: 'active', event: 'TICK', effects: [['emit', 'RECEIVED', {}]] }],
              },
              emits: [{ event: 'RECEIVED', scope: 'external' }],
              listens: [
                { event: 'PING', triggers: 'TICK', scope: 'external', source: { kind: 'trait', trait: 'Source' } },
              ],
            },
          ],
          pages: [],
        },
      ],
    };

    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(schema);

    const result = await probeListenCascades(runtime, schema);
    expect(result.probed).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.check).toBe('listen-source-cannot-emit');
    expect(result.findings[0]?.trait).toBe('Listener');
    expect(result.findings[0]?.sourceTrait).toBe('Source');
  });

  // The three fixtures below are the `producibleEvents`/embed-host
  // convergence (`event-producers.ts`'s own emitter oracle): a source that can
  // structurally produce the event by a mechanism this probe cannot
  // dispatch-and-observe server-side (only a literal `emit` effect or a
  // fetch/persist success|failure option lands in `response.emittedEvents`)
  // must SKIP rather than report `listen-source-cannot-emit` — that static
  // side is already proven by the compiler's `ORB_X_LISTEN_SOURCE_UNRESOLVED`.

  it('reports 0 findings when the source declares the event only in emits[] (no literal effect emit)', async () => {
    const schema: OrbitalSchema = {
      name: 'ContractOnlyApp',
      orbitals: [
        {
          name: 'ContractOnlyOrbital',
          entity: { name: 'Ping', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
          traits: [
            {
              // `emits` names PING but no transition anywhere literally
              // emits it — structurally producible (the same contract
              // `producibleEvents` trusts), but
              // nothing this probe can dispatch and observe.
              name: 'Source',
              scope: 'instance',
              linkedEntity: 'Ping',
              stateMachine: {
                states: [{ name: 'idle', isInitial: true }],
                events: [{ key: 'FIRE', name: 'Fire' }],
                transitions: [{ from: 'idle', to: 'idle', event: 'FIRE', effects: [['set', '@entity.id', '@payload.id']] }],
              },
              emits: [{ event: 'PING', scope: 'external' }],
            },
            {
              name: 'Listener',
              scope: 'instance',
              linkedEntity: 'Ping',
              stateMachine: {
                states: [{ name: 'active', isInitial: true }],
                events: [{ key: 'TICK', name: 'Tick' }],
                transitions: [{ from: 'active', to: 'active', event: 'TICK', effects: [['emit', 'RECEIVED', {}]] }],
              },
              emits: [{ event: 'RECEIVED', scope: 'external' }],
              listens: [
                { event: 'PING', triggers: 'TICK', scope: 'external', source: { kind: 'trait', trait: 'Source' } },
              ],
            },
          ],
          pages: [],
        },
      ],
    };

    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(schema);

    const result = await probeListenCascades(runtime, schema);
    expect(result.probed).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it('reports 0 findings when the source produces the event via a registry event-outlet prop (searchEvent)', async () => {
    const schema: OrbitalSchema = {
      name: 'SearchOutletApp',
      orbitals: [
        {
          name: 'SearchOutletOrbital',
          entity: { name: 'Ping', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
          traits: [
            {
              // `dashboard-layout`'s `searchEvent` prop is a registry
              // event-outlet (`kind: "event-ref"`, `eventKeyPropsOf`) —
              // declared, real, user-clickable, but a client bus emit this
              // server-side probe cannot dispatch and observe.
              name: 'AppLayout',
              scope: 'instance',
              linkedEntity: 'Ping',
              stateMachine: {
                states: [{ name: 'idle', isInitial: true }],
                events: [{ key: 'FIRE', name: 'Fire' }],
                transitions: [
                  {
                    from: 'idle',
                    to: 'idle',
                    event: 'FIRE',
                    effects: [['render-ui', 'main', { type: 'dashboard-layout', searchEvent: 'NOTE_SEARCH' }]],
                  },
                ],
              },
            },
            {
              name: 'Listener',
              scope: 'instance',
              linkedEntity: 'Ping',
              stateMachine: {
                states: [{ name: 'active', isInitial: true }],
                events: [{ key: 'REFETCH_QUERY', name: 'Refetch' }],
                transitions: [{ from: 'active', to: 'active', event: 'REFETCH_QUERY', effects: [['emit', 'RECEIVED', {}]] }],
              },
              emits: [{ event: 'RECEIVED', scope: 'external' }],
              listens: [
                {
                  event: 'NOTE_SEARCH',
                  triggers: 'REFETCH_QUERY',
                  scope: 'external',
                  source: { kind: 'trait', trait: 'AppLayout' },
                },
              ],
            },
          ],
          pages: [],
        },
      ],
    };

    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(schema);

    const result = await probeListenCascades(runtime, schema);
    expect(result.probed).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it('reports 0 findings when the event is produced by an embedded child (compiler-lowered inline button) under the source', async () => {
    const schema: OrbitalSchema = {
      name: 'EmbedApp',
      orbitals: [
        {
          name: 'EmbedOrbital',
          entity: { name: 'Ping', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
          traits: [
            {
              // The host's own render tree carries only the opaque
              // `@trait.X` reference — the `action:` producer lives on the
              // CHILD, exactly what a JSX inline `<Trait.traits.X
              // action={E} />` embed lowers to (`InlineButtonRenderN`).
              name: 'Catalog',
              scope: 'instance',
              linkedEntity: 'Ping',
              stateMachine: {
                states: [{ name: 'idle', isInitial: true }],
                events: [{ key: 'FIRE', name: 'Fire' }],
                transitions: [
                  {
                    from: 'idle',
                    to: 'idle',
                    event: 'FIRE',
                    effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.InlineButtonRender1'] }]],
                  },
                ],
              },
            },
            {
              name: 'InlineButtonRender1',
              scope: 'instance',
              linkedEntity: 'Ping',
              stateMachine: {
                states: [{ name: 'idle', isInitial: true }],
                events: [{ key: 'FIRE', name: 'Fire' }],
                transitions: [
                  {
                    from: 'idle',
                    to: 'idle',
                    event: 'FIRE',
                    effects: [['render-ui', 'main', { type: 'button', action: 'CREATE_DRAFT', label: 'New' }]],
                  },
                ],
              },
            },
            {
              name: 'Persistor',
              scope: 'instance',
              linkedEntity: 'Ping',
              stateMachine: {
                states: [{ name: 'idle', isInitial: true }],
                events: [{ key: 'DO_CREATE', name: 'DoCreate' }],
                transitions: [{ from: 'idle', to: 'idle', event: 'DO_CREATE', effects: [['emit', 'CREATED', {}]] }],
              },
              emits: [{ event: 'CREATED', scope: 'external' }],
              listens: [
                {
                  event: 'CREATE_DRAFT',
                  triggers: 'DO_CREATE',
                  scope: 'external',
                  // Declared source is the HOST (Catalog), not the embedded
                  // child — embedded chrome emits under its embedder's
                  // scope.
                  source: { kind: 'trait', trait: 'Catalog' },
                },
              ],
            },
          ],
          pages: [],
        },
      ],
    };

    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(schema);

    const result = await probeListenCascades(runtime, schema);
    expect(result.probed).toBe(0);
    expect(result.findings).toEqual([]);
  });
});

/**
 * Self-identity fixture (B1-V item C): `Employee [identity]` declares
 * `@read (or (= @user.role "approver") (= (object/get @entity id) @user.id))` —
 * `std-time-tracking`'s actual shape. The row's OWN `id` is the ownership
 * key, not a relation column, so the seeded row's `id` must equal the
 * viewer's id (`ownerFieldsFromSchema`'s self-identity arm) or the by-id
 * fetch's access check filters it out exactly like a genuinely missing row.
 */
function selfIdentityFetchApp(): OrbitalSchema {
  return {
    name: 'EmployeeApp',
    orbitals: [
      {
        name: 'EmployeeOrbital',
        entity: {
          name: 'Employee',
          identity: true,
          persistence: 'runtime',
          // The real `.lolo` -> `.orb` shape (verified against
          // `packages/almadar-behaviors/behaviors/registry/app/organisms/
          // std-time-tracking.orb`): `(object/get @entity id)`, not the
          // bare dotted string.
          read_policy: ['or', ['=', '@user.role', 'approver'], ['=', ['object/get', '@entity', 'id'], '@user.id']],
          fields: [{ name: 'id', type: 'string' }, { name: 'name', type: 'string' }],
        },
        traits: [
          {
            name: 'Source',
            scope: 'instance',
            linkedEntity: 'Employee',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'loading' }],
              events: [{ key: 'INIT', name: 'Init', payloadSchema: [{ name: 'id', type: 'string' }] }],
              transitions: [
                {
                  from: 'idle',
                  to: 'loading',
                  event: 'INIT',
                  guard: ['!=', ['str/default', '@payload.id', ''], ''],
                  effects: [
                    ['fetch', 'Employee', { id: '@payload.id', emit: { success: 'EmployeeLoaded', failure: 'EmployeeLoadFailed' } }],
                  ],
                },
              ],
            },
            emits: [
              { event: 'EmployeeLoaded', scope: 'external' },
              { event: 'EmployeeLoadFailed', scope: 'external' },
            ],
          },
          {
            name: 'Listener',
            scope: 'instance',
            linkedEntity: 'Employee',
            stateMachine: {
              states: [{ name: 'active', isInitial: true }],
              events: [{ key: 'RECEIVED', name: 'Received' }],
              transitions: [{ from: 'active', to: 'active', event: 'RECEIVED', effects: [['emit', 'DONE', {}]] }],
            },
            emits: [{ event: 'DONE', scope: 'external' }],
            listens: [
              {
                event: 'EmployeeLoaded',
                triggers: 'RECEIVED',
                scope: 'external',
                source: { kind: 'trait', trait: 'Source' },
              },
            ],
          },
        ],
        pages: [],
      },
    ],
  };
}

describe('probeListenCascades — self-identity seeding (B1-V item C)', () => {
  it('stamps the seeded row\'s own id to the viewer id and reports 0 findings', async () => {
    const schema = selfIdentityFetchApp();
    const persistence = new InMemoryPersistence();
    const runtime = new OrbitalServerRuntime({ debug: false, persistence });
    await runtime.register(schema);

    const result = await probeListenCascades(runtime, schema, persistence);
    expect(result.findings).toEqual([]);
  });
});

describe('probeListenCascades — persistence seeding (item B)', () => {
  it('with a persistence adapter, an owner-scoped by-id fetch hits the seeded row and reports 0 findings', async () => {
    const schema = ownerScopedFetchApp();
    const persistence = new InMemoryPersistence();
    const runtime = new OrbitalServerRuntime({ debug: false, persistence });
    await runtime.register(schema);

    const result = await probeListenCascades(runtime, schema, persistence);
    expect(result.findings).toEqual([]);
  });

  it('seeding does not mask a genuinely broken bus route (wrong eventId still reports listen-cascade-not-delivered)', async () => {
    // Same owner-scoped by-id fetch (so WidgetLoaded genuinely fires this
    // time — the "cannot emit" gate is not what's under test here) but the
    // listen carries a WRONG explicit `eventId`, bypassing
    // `resolveSourceEmitEventId` exactly like the vim-mode regression
    // below: the emitter's own `emits[]` contract stamps no `eventId`, so
    // it routes under the bare event name, while the listener now
    // subscribes under an id key nothing emits under.
    const schema = ownerScopedFetchApp('evt_01WRONGWRONGWRONGWRONGWRO');
    const persistence = new InMemoryPersistence();
    const runtime = new OrbitalServerRuntime({ debug: false, persistence });
    await runtime.register(schema);

    const result = await probeListenCascades(runtime, schema, persistence);
    const broken = result.findings.find(
      (f) => f.check === 'listen-cascade-not-delivered' && f.event === 'WidgetLoaded' && f.triggers === 'RECEIVED',
    );
    expect(broken).toBeDefined();
    expect(broken?.sourceTrait).toBe('Source');
  });
});

// ---------------------------------------------------------------------------
// Real plugin: resolves the checked-in vim-mode registry .orb the way the
// studio does (`orbital resolve`), then runs the probe against it via a real
// `OrbitalServerRuntime`. Skips (not fails) when the dev `orbital` binary
// isn't on this machine.
// ---------------------------------------------------------------------------
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const ORB_PATH = join(
  REPO_ROOT,
  'packages/almadar-behaviors/behaviors/registry/plugins/atoms/vim-mode.orb',
);
const ORB_BIN = join(homedir(), 'bin', 'orbital');
const canRunRealPlugin = existsSync(ORB_BIN) && existsSync(ORB_PATH);

function resolveViaCli(schema: object): OrbitalSchema {
  const tmpFile = join(tmpdir(), `vim-mode-cascade-probe-${Date.now()}-${Math.random().toString(36).slice(2)}.orb`);
  writeFileSync(tmpFile, JSON.stringify(schema, null, 2));
  try {
    const out = execFileSync(ORB_BIN, ['resolve', tmpFile], {
      encoding: 'utf-8',
      env: { ...process.env, ALMADAR_DEV: '1', ALMADAR_ROOT: REPO_ROOT },
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(out) as OrbitalSchema;
  } finally {
    unlinkSync(tmpFile);
  }
}

/** Find `VimStudioBridge`'s `listens { Shell.PLUGIN_ENABLED -> ENABLED }`
 *  entry on the resolved schema, structurally (source.trait === 'Shell',
 *  event === 'PLUGIN_ENABLED') — not by trait name, so this stays correct
 *  if VimStudioBridge is ever renamed. */
function findPluginEnabledListen(schema: OrbitalSchema): TraitEventListener | undefined {
  for (const orb of schema.orbitals) {
    for (const ref of orb.traits) {
      if (typeof ref !== 'object' || !('listens' in ref)) continue;
      for (const listen of ref.listens ?? []) {
        if (listen.event === 'PLUGIN_ENABLED' && listen.source?.kind === 'trait' && listen.source.trait === 'Shell') {
          return listen;
        }
      }
    }
  }
  return undefined;
}

describe.skipIf(!canRunRealPlugin)('probeListenCascades — vim-mode plugin (real schema)', () => {
  it('reports 0 findings against @almadar/runtime HEAD (the resolveSourceEmitEventId fix)', async () => {
    const raw = JSON.parse(readFileSync(ORB_PATH, 'utf-8'));
    const resolved = resolveViaCli(raw);

    // Sanity: the listen this bug was about really has no eventId of its
    // own (the partial-ledger shape `orb resolve` produces today) — if this
    // ever changes, the negative control below needs revisiting.
    const liveListen = findPluginEnabledListen(resolved);
    expect(liveListen).toBeDefined();
    expect(liveListen?.eventId).toBeUndefined();

    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(resolved);

    const result = await probeListenCascades(runtime, resolved);
    expect(result.findings).toEqual([]);
  });

  it('negative control: a WRONG explicit eventId on that same listen reproduces the pre-fix break', async () => {
    const raw = JSON.parse(readFileSync(ORB_PATH, 'utf-8'));
    const resolved = resolveViaCli(raw);

    const listen = findPluginEnabledListen(resolved);
    expect(listen).toBeDefined();
    // Bypasses `resolveSourceEmitEventId` entirely: `listener.eventId ??
    // resolveSourceEmitEventId(...)` short-circuits on this now-wrong value,
    // so the listener subscribes under a bus key the emitter never uses —
    // exactly the pre-fix routing-key mismatch.
    if (listen) listen.eventId = asEventId('evt_01WRONGWRONGWRONGWRONGWRO');

    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(resolved);

    const result = await probeListenCascades(runtime, resolved);
    const broken = result.findings.find(
      (f) => f.check === 'listen-cascade-not-delivered' && f.event === 'PLUGIN_ENABLED' && f.triggers === 'ENABLED',
    );
    expect(broken).toBeDefined();
    expect(broken?.sourceTrait).toBe('Shell');
  });
});
