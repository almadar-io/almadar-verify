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
import type { OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '@almadar/runtime/OrbitalServerRuntime';
import { probeListenCascades } from '../probe-listen-cascades.js';

describe('probeListenCascades — synthetic fixtures', () => {
  it('reports 0 findings when the source emits and the listener\'s cascade fires', async () => {
    const schema = {
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
    } as unknown as OrbitalSchema;

    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(schema);

    const result = await probeListenCascades(runtime, schema);
    expect(result.probed).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it('reports listen-source-cannot-emit when the declared source never emits the event', async () => {
    const schema = {
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
    } as unknown as OrbitalSchema;

    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(schema);

    const result = await probeListenCascades(runtime, schema);
    expect(result.probed).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.check).toBe('listen-source-cannot-emit');
    expect(result.findings[0]?.trait).toBe('Listener');
    expect(result.findings[0]?.sourceTrait).toBe('Source');
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
function findPluginEnabledListen(
  schema: OrbitalSchema,
): { event: string; eventId?: string; triggers: string; source?: { kind: string; trait?: string } } | undefined {
  for (const orb of schema.orbitals as unknown as Array<{ traits: unknown[] }>) {
    for (const ref of orb.traits) {
      const trait = ref as { listens?: Array<{ event: string; eventId?: string; triggers: string; source?: { kind: string; trait?: string } }> };
      for (const listen of trait.listens ?? []) {
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
    (listen as { eventId?: string }).eventId = 'evt_01WRONGWRONGWRONGWRONGWRO';

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
