import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Orbital, OrbitalSchema, StateMachine, Trait, TraitEventContract, TraitEventListener } from '@almadar/core';
import { lintPluginWiring, type PluginWiringTarget } from '../plugin-wiring-lint.js';

// ── Fixture builders — every field the real types require is supplied, so
// no `as unknown as X` boundary cast is needed (unlike the older sibling
// `wiring-lint.test.ts`, which predates this convention). ──────────────────

function trait(partial: Partial<Trait> & { name: string }): Trait {
  return { scope: 'instance', ...partial };
}

function machine(transitions: StateMachine['transitions']): StateMachine {
  return { states: [], events: [], transitions };
}

function orbital(partial: Partial<Orbital> & { name: string }): Orbital {
  // `Orbital.entity`/`Orbital.traits` are required in the real type; these
  // fixture defaults are never read by `lintPluginWiring` unless a test
  // overrides them (the payload-type-mismatch cases override `entity` with
  // a real linked entity).
  return {
    entity: { name: `${partial.name}Item`, fields: [{ name: 'id', type: 'string' }] },
    traits: [],
    pages: [],
    ...partial,
  };
}

function schema(partial: Partial<OrbitalSchema> & { name: string; orbitals: Orbital[] }): OrbitalSchema {
  return { ...partial };
}

function emitsExternal(event: string, payloadSchema: TraitEventContract['payloadSchema'] = []): TraitEventContract[] {
  return [{ event, scope: 'external', payloadSchema }];
}

describe('lintPluginWiring — plugin-emit-no-host-listener', () => {
  it('is clean when the target bare-consumes the emit by name (a matching payload)', () => {
    const plugin = schema({
      name: 'PluginApp',
      orbitals: [
        orbital({
          name: 'PluginOrb',
          traits: [
            trait({
              name: 'Emitter',
              emits: emitsExternal('PING', [{ name: 'id', type: 'string', required: true }]),
            }),
          ],
        }),
      ],
    });
    const target: PluginWiringTarget = {
      name: 'host-atom',
      schema: schema({
        name: 'HostApp',
        orbitals: [
          orbital({
            name: 'HostOrb',
            traits: [
              trait({
                name: 'Host',
                stateMachine: machine([
                  { from: 'idle', event: 'PING', to: 'idle', effects: [['set', '@entity.id', '@payload.id']] },
                ]),
              }),
            ],
          }),
        ],
      }),
    };
    const result = lintPluginWiring(plugin, [target]);
    expect(result.findings).toEqual([]);
  });

  it('flags an external emit no target bare-consumes and no same-plugin trait listens for', () => {
    const plugin = schema({
      name: 'PluginApp',
      orbitals: [
        orbital({
          name: 'PluginOrb',
          traits: [trait({ name: 'Emitter', emits: emitsExternal('PONG') })],
        }),
      ],
    });
    const target: PluginWiringTarget = {
      name: 'host-atom',
      schema: schema({
        name: 'HostApp',
        orbitals: [
          orbital({
            name: 'HostOrb',
            traits: [trait({ name: 'Host', stateMachine: machine([{ from: 'idle', event: 'PING', to: 'idle', effects: [] }]) })],
          }),
        ],
      }),
    };
    const result = lintPluginWiring(plugin, [target]);
    expect(result.errors).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.check).toBe('plugin-emit-no-host-listener');
    expect(result.findings[0]?.trait).toBe('Emitter');
    expect(result.findings[0]?.message).toContain('PONG');
  });

  it('is clean when a same-plugin trait listens for the emit even with no target match', () => {
    const emitter = trait({ name: 'Emitter', emits: emitsExternal('TICK') });
    const listener = trait({
      name: 'Listener',
      listens: [{ event: 'TICK', triggers: 'TICK', source: { kind: 'trait', trait: 'Emitter' } }],
    });
    const plugin = schema({
      name: 'PluginApp',
      orbitals: [orbital({ name: 'PluginOrb', traits: [emitter, listener] })],
    });
    const result = lintPluginWiring(plugin, []);
    expect(result.findings).toEqual([]);
  });

  it('excludes an internal-scope emit — only external emits are the plugin’s host-facing surface', () => {
    const plugin = schema({
      name: 'PluginApp',
      orbitals: [
        orbital({
          name: 'PluginOrb',
          traits: [trait({ name: 'Emitter', emits: [{ event: 'LOCAL_ONLY', scope: 'internal', payloadSchema: [] }] })],
        }),
      ],
    });
    expect(lintPluginWiring(plugin, []).findings).toEqual([]);
  });
});

describe('lintPluginWiring — plugin-emit-payload-mismatch', () => {
  it('flags a required field the target reads that the emit never supplies', () => {
    const plugin = schema({
      name: 'PluginApp',
      orbitals: [
        orbital({
          name: 'PluginOrb',
          traits: [trait({ name: 'Emitter', emits: emitsExternal('SAVE', [{ name: 'id', type: 'string' }]) })],
        }),
      ],
    });
    const target: PluginWiringTarget = {
      name: 'host-atom',
      schema: schema({
        name: 'HostApp',
        orbitals: [
          orbital({
            name: 'HostOrb',
            traits: [
              trait({
                name: 'Host',
                stateMachine: machine([
                  {
                    from: 'idle',
                    event: 'SAVE',
                    to: 'idle',
                    effects: [
                      ['set', '@entity.id', '@payload.id'],
                      ['set', '@entity.title', '@payload.title'],
                    ],
                  },
                ]),
              }),
            ],
          }),
        ],
      }),
    };
    const result = lintPluginWiring(plugin, [target]);
    expect(result.errors).toBe(1);
    expect(result.findings[0]?.check).toBe('plugin-emit-payload-mismatch');
    expect(result.findings[0]?.message).toContain('title');
  });

  it('flags a field type that disagrees with the target entity field it is written into', () => {
    const plugin = schema({
      name: 'PluginApp',
      orbitals: [
        orbital({
          name: 'PluginOrb',
          traits: [trait({ name: 'Emitter', emits: emitsExternal('SET_COUNT', [{ name: 'count', type: 'string' }]) })],
        }),
      ],
    });
    const target: PluginWiringTarget = {
      name: 'host-atom',
      schema: schema({
        name: 'HostApp',
        orbitals: [
          orbital({
            name: 'HostOrb',
            entity: { name: 'HostItem', fields: [{ name: 'count', type: 'number' }] },
            traits: [
              trait({
                name: 'Host',
                linkedEntity: 'HostItem',
                stateMachine: machine([
                  { from: 'idle', event: 'SET_COUNT', to: 'idle', effects: [['set', '@entity.count', '@payload.count']] },
                ]),
              }),
            ],
          }),
        ],
      }),
    };
    const result = lintPluginWiring(plugin, [target]);
    expect(result.errors).toBe(1);
    expect(result.findings[0]?.check).toBe('plugin-emit-payload-mismatch');
    expect(result.findings[0]?.message).toContain('string');
    expect(result.findings[0]?.message).toContain('number');
  });

  it('is clean when the emit supplies every field the target reads with matching types', () => {
    const plugin = schema({
      name: 'PluginApp',
      orbitals: [
        orbital({
          name: 'PluginOrb',
          traits: [trait({ name: 'Emitter', emits: emitsExternal('SET_COUNT', [{ name: 'count', type: 'number' }]) })],
        }),
      ],
    });
    const target: PluginWiringTarget = {
      name: 'host-atom',
      schema: schema({
        name: 'HostApp',
        orbitals: [
          orbital({
            name: 'HostOrb',
            entity: { name: 'HostItem', fields: [{ name: 'count', type: 'number' }] },
            traits: [
              trait({
                name: 'Host',
                linkedEntity: 'HostItem',
                stateMachine: machine([
                  { from: 'idle', event: 'SET_COUNT', to: 'idle', effects: [['set', '@entity.count', '@payload.count']] },
                ]),
              }),
            ],
          }),
        ],
      }),
    };
    expect(lintPluginWiring(plugin, [target]).findings).toEqual([]);
  });
});

describe('lintPluginWiring — plugin-listen-source-not-host', () => {
  const listenTo = (event: string, source: TraitEventListener['source']): Trait =>
    trait({ name: 'Listener', listens: [{ event, triggers: event, source }] });

  it('flags a source-qualified listen whose source trait is declared nowhere (plugin or target)', () => {
    const plugin = schema({
      name: 'PluginApp',
      orbitals: [orbital({ name: 'PluginOrb', traits: [listenTo('X', { kind: 'trait', trait: 'Ghost' })] })],
    });
    const result = lintPluginWiring(plugin, []);
    expect(result.errors).toBe(1);
    expect(result.findings[0]?.check).toBe('plugin-listen-source-not-host');
    expect(result.findings[0]?.message).toContain('Ghost');
  });

  it('is clean when the source trait is declared in the plugin’s own orbital', () => {
    const source = trait({ name: 'Source' });
    const plugin = schema({
      name: 'PluginApp',
      orbitals: [orbital({ name: 'PluginOrb', traits: [source, listenTo('X', { kind: 'trait', trait: 'Source' })] })],
    });
    expect(lintPluginWiring(plugin, []).findings).toEqual([]);
  });

  it('is clean when the source trait is declared in a target atom', () => {
    const plugin = schema({
      name: 'PluginApp',
      orbitals: [orbital({ name: 'PluginOrb', traits: [listenTo('X', { kind: 'orbital', orbital: 'HostOrb', trait: 'Host' })] })],
    });
    const target: PluginWiringTarget = {
      name: 'host-atom',
      schema: schema({
        name: 'HostApp',
        orbitals: [orbital({ name: 'HostOrb', traits: [trait({ name: 'Host' })] })],
      }),
    };
    expect(lintPluginWiring(plugin, [target]).findings).toEqual([]);
  });

  it('ignores a wildcard (`kind: any`) listen source and a bare local declaration (`source: undefined`)', () => {
    const plugin = schema({
      name: 'PluginApp',
      orbitals: [
        orbital({
          name: 'PluginOrb',
          traits: [
            listenTo('X', { kind: 'any' }),
            trait({ name: 'BareLocal', listens: [{ event: 'Y', triggers: 'Y' }] }),
          ],
        }),
      ],
    });
    expect(lintPluginWiring(plugin, []).findings).toEqual([]);
  });
});

describe('lintPluginWiring — relay vs request emit attribution', () => {
  it('is clean for a RELAY emit — every firing arm is triggered by an event not declared in this trait\'s own listens (and not INIT)', () => {
    const plugin = schema({
      name: 'PluginApp',
      orbitals: [
        orbital({
          name: 'PluginOrb',
          traits: [
            trait({
              name: 'Relay',
              stateMachine: machine([{ from: 'idle', event: 'HOST_PUSH', to: 'idle', effects: [['emit', 'PUSHED', {}]] }]),
              emits: emitsExternal('PUSHED'),
            }),
          ],
        }),
      ],
    });
    // No target at all, and no same-plugin listener either — a REQUEST emit
    // here would trip `plugin-emit-no-host-listener`; a relay emit does not.
    expect(lintPluginWiring(plugin, []).findings).toEqual([]);
  });

  it('flags a REQUEST emit — the firing arm is triggered by a declared listens route — when no target consumes it', () => {
    const plugin = schema({
      name: 'PluginApp',
      orbitals: [
        orbital({
          name: 'PluginOrb',
          traits: [
            trait({
              name: 'Requester',
              listens: [{ event: 'UPSTREAM', triggers: 'ASK' }],
              stateMachine: machine([{ from: 'idle', event: 'ASK', to: 'idle', effects: [['emit', 'ASKED', {}]] }]),
              emits: emitsExternal('ASKED'),
            }),
          ],
        }),
      ],
    });
    const result = lintPluginWiring(plugin, []);
    expect(result.errors).toBe(1);
    expect(result.findings[0]?.check).toBe('plugin-emit-no-host-listener');
    expect(result.findings[0]?.trait).toBe('Requester');
  });
});

// ── Real files — vim-mode.orb (io plugins/atoms) against studio-shell.orb
// (host protocol) and std-modal-editor.orb (composed capability), then again
// with ui-code-block.orb (editor capability) added. Both plugin and target
// inputs are RESOLVED (`orbital resolve`) — the registry `.orb` files on
// disk store `uses`-composed traits as unresolved `{ ref }` stubs with no
// `emits`/`stateMachine` of their own (see the file header doc). ──────────

const REPO_ROOT = process.env['ALMADAR_ROOT'] ?? resolve(import.meta.dirname, '../../../../..');
const ORB_BIN = process.env['ORB_BIN'] ?? resolve(homedir(), 'bin', 'orbital');

function resolveOrb(relPath: string): OrbitalSchema {
  const abs = resolve(REPO_ROOT, relPath);
  const json = execFileSync(ORB_BIN, ['resolve', abs], {
    encoding: 'utf-8',
    env: { ...process.env, ALMADAR_DEV: '1', ALMADAR_ROOT: REPO_ROOT },
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(json) as OrbitalSchema;
}

const VIM_MODE_PATH = 'packages/almadar-behaviors/behaviors/registry/plugins/atoms/vim-mode.orb';
const STUDIO_SHELL_PATH = 'packages/almadar-behaviors/behaviors/registry/studio/atoms/studio-shell.orb';
const STD_MODAL_EDITOR_PATH = 'packages/almadar-std/behaviors/registry/ui/core/atoms/std-modal-editor.orb';
const UI_CODE_BLOCK_PATH = 'packages/almadar-std/behaviors/registry/ui/core/molecules/ui-code-block.orb';

// Skips the whole block when the `orbital` binary isn't on this machine
// (CLAUDE.md: MCP/verify tooling runs `~/bin/orbital` — a standing
// dependency for every resolve-backed check in this repo, not a heuristic
// fallback) rather than silently passing.
let orbAvailable = true;
try {
  execFileSync(ORB_BIN, ['--version'], { stdio: 'ignore' });
} catch {
  orbAvailable = false;
}

describe.skipIf(!orbAvailable)('lintPluginWiring — real files: vim-mode against studio-shell + std-modal-editor', () => {
  it('flags only MOTION/OPERATE/INSERT_TEXT (Modes is a REQUEST trait, no target consumes those 3 yet); Shell\'s 7 unconsumed emits are RELAYS and are not flagged', () => {
    const vimMode = resolveOrb(VIM_MODE_PATH);
    const studioShell = resolveOrb(STUDIO_SHELL_PATH);
    const stdModalEditor = resolveOrb(STD_MODAL_EDITOR_PATH);

    const result = lintPluginWiring(vimMode, [
      { name: 'studio-shell', schema: studioShell },
      { name: 'std-modal-editor', schema: stdModalEditor },
    ]);

    expect(result.findings.every((f) => f.check === 'plugin-emit-no-host-listener')).toBe(true);
    const eventOf = (f: (typeof result.findings)[number]): string | undefined => f.message.match(/emits '([A-Z_]+)'/)?.[1];

    // `Modes` is composed via `Modes = Modal.traits.Modes -> VimEditorMode
    // { listens { Shell.KEY -> KEY with {...} } }` — every arm in `Modes` is
    // triggered by `KEY`, which IS a declared `listens[].triggers` entry (the
    // REBIND), so `Modes` is a REQUEST trait: its neutral MOTION/OPERATE/
    // INSERT_TEXT emits are the plugin's own editor-manipulation output and
    // need a target listener — `ui-code-block`'s job, added in the next
    // test. SET_MODE and EX_COMMAND are absent from this set even though
    // they're ALSO unmatched by any target, because vim-mode's own
    // `VimStudioBridge` already consumes them same-app
    // (`listens { Modes.SET_MODE -> MODE_TICK, Modes.EX_COMMAND -> COMMAND_TICK }`).
    const modesEvents = new Set(result.findings.filter((f) => f.trait === 'Modes').map(eventOf));
    expect(modesEvents).toEqual(new Set(['MOTION', 'OPERATE', 'INSERT_TEXT']));

    // `Shell = ShellAtom.traits.StudioShellTrait -> VimShellState {}` is an
    // EMPTY rebind — it inherits `studio-shell`'s own (empty) `listens`, so
    // every `SHELL_*`-triggered arm in `Shell` is host-injected
    // (`processOrbitalEvent`, bypassing this trait's subscription surface
    // entirely): all 9 of `Shell`'s inherited emits are RELAYS. KEY and
    // PLUGIN_ENABLED are also same-plugin-consumed (Modes listens Shell.KEY;
    // VimStudioBridge listens Shell.PLUGIN_ENABLED) — independent of the
    // relay exemption, both apply. The other 7 (TAB_ACTIVE, EDITOR_FOCUS,
    // EDITOR_BLUR, VIEW_FOCUSED, PANEL_TOGGLED, PLUGIN_DISABLED, PERSONA)
    // used to be flagged as dead wires under the old "every composed-trait
    // emit is the plugin's own" attribution; they are relays — a plugin
    // ignoring a host→plugin signal it never asked to receive is not a dead
    // wire — so no finding for `Shell` at all.
    const shellFindings = result.findings.filter((f) => f.trait === 'Shell');
    expect(shellFindings).toEqual([]);
    expect(result.findings).toHaveLength(modesEvents.size);
    expect(new Set(result.findings.map((f) => f.trait))).toEqual(new Set(['Modes']));
  });

  it('drops the MOTION/OPERATE/INSERT_TEXT findings once ui-code-block is added as a target', () => {
    const vimMode = resolveOrb(VIM_MODE_PATH);
    const studioShell = resolveOrb(STUDIO_SHELL_PATH);
    const stdModalEditor = resolveOrb(STD_MODAL_EDITOR_PATH);
    const uiCodeBlock = resolveOrb(UI_CODE_BLOCK_PATH);

    const result = lintPluginWiring(vimMode, [
      { name: 'studio-shell', schema: studioShell },
      { name: 'std-modal-editor', schema: stdModalEditor },
      { name: 'ui-code-block', schema: uiCodeBlock },
    ]);

    // With `ui-code-block` added, `Modes`'s MOTION/OPERATE/INSERT_TEXT
    // (REQUEST emits) now bare-match a target consumption site; `Shell`'s 7
    // unconsumed emits stay unflagged (RELAY, per the previous test) — the
    // whole roster is clean.
    expect(result.findings).toEqual([]);
  });
});
