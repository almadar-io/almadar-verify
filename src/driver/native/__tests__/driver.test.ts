import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createNativeDriver } from '../driver.js';
import { parseIosTree, parseAndroidDump, type NativeElement } from '../tree.js';
import { FakeBridge, FakeDevice, fakeClock, step, trait } from './fakes.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(join(here, '..', '__fixtures__', name), 'utf8');
const iosTree = (): NativeElement[] => parseIosTree(fixture('ios-tree.json'));
const androidTree = (): NativeElement[] => parseAndroidDump(fixture('android-dump.xml'));
const iosSlotTree = (name: string): NativeElement[] => parseIosTree(fixture(`ios-tree-slots-${name}.json`));

function build(trees: NativeElement[][], opts: { refuse?: string[]; entityNames?: string[] } = {}) {
  const device = new FakeDevice(trees, new Set(opts.refuse ?? []));
  const bridge = new FakeBridge();
  const clock = fakeClock();
  const driver = createNativeDriver({ device, bridge, entityNames: opts.entityNames ?? ['Task'], ...clock, screenshots: true });
  const ctx = { outputDir: mkdtempSync(join(tmpdir(), 'native-driver-')), trait };
  return { device, bridge, driver, ctx, clock };
}

describe.each([
  ['ios', iosTree],
  ['android', androidTree],
] as const)('triggerDOM (%s tree)', (_name, load) => {
  it('taps the action inside the planner-resolved row', async () => {
    const { driver, ctx, device } = build([load()]);
    const result = await driver.triggerDOM(ctx, step({ testKind: 'crud-edit', targetRowId: '5' }));
    expect(result).toBe(true);
    expect(device.taps).toEqual([{ id: 'action-EDIT', within: 'row-5' }]);
  });

  it('takes the first row in tree order when the step names no row', async () => {
    const { driver, ctx, device } = build([load()]);
    await driver.triggerDOM(ctx, step({ testKind: 'crud-edit' }));
    expect(device.taps[0]).toEqual({ id: 'action-EDIT', within: 'row-3' });
  });

  it('uses the open-affordance event, not the receiver event', async () => {
    const { driver, ctx, device } = build([load()]);
    await driver.triggerDOM(ctx, step({ event: 'DELETE', openAffordanceEvent: 'EDIT', testKind: 'crud-delete', targetRowId: '3' }));
    expect(device.taps[0]?.id).toBe('action-EDIT');
  });

  it('matches a qualified action id', async () => {
    const { driver, ctx, device } = build([load()]);
    await driver.triggerDOM(ctx, step({ event: 'DELETE', testKind: 'crud-delete', targetRowId: '3' }));
    expect(device.taps[0]?.id).toBe('action-Tasks.TaskBrowse.DELETE');
  });

  it('returns false for a non-row step with no affordance, so the kernel falls back to sendEvent', async () => {
    const { driver, ctx, device } = build([load()]);
    expect(await driver.triggerDOM(ctx, step({ event: 'NOPE', triggerKind: 'bus' }))).toBe(false);
    expect(device.taps).toEqual([]);
  });

  it('returns no-row-affordance when a crud-edit row exposes no such action', async () => {
    const { driver, ctx } = build([load()]);
    expect(await driver.triggerDOM(ctx, step({ event: 'NOPE', testKind: 'crud-edit', targetRowId: '5' }))).toBe('no-row-affordance');
  });

  it('control: isRowAction=false downgrades the same miss to plain false', async () => {
    const { driver, ctx } = build([load()]);
    expect(await driver.triggerDOM(ctx, step({ event: 'NOPE', testKind: 'crud-edit', targetRowId: '5', isRowAction: false }))).toBe(false);
  });

  it('never substitutes another row when the resolved row exists but lacks the action', async () => {
    const { driver, ctx, device } = build([load()]);
    const result = await driver.triggerDOM(ctx, step({ event: 'DELETE', testKind: 'crud-delete', targetRowId: '5', isRowAction: true }));
    expect(result).toBe('no-row-affordance');
    expect(device.taps.some((t) => t.id.includes('DELETE'))).toBe(false);
  });
});

describe('triggerDOM recovery paths', () => {
  it('falls back to the unscoped action when the action is not row tagged at all', async () => {
    const { driver, ctx, device } = build([iosTree()]);
    const result = await driver.triggerDOM(ctx, step({ event: 'CREATE', testKind: 'crud-edit', targetRowId: '5' }));
    expect(result).toBe(true);
    expect(device.taps).toEqual([{ id: 'action-CREATE' }]);
  });

  it('opens the row overflow and taps the item from the menu tree', async () => {
    const base = iosTree().filter((e) => !(e.id === 'action-EDIT' && e.ancestors.includes('row-5')));
    const menu = [...base, { ...iosTree().find((e) => e.id === 'action-EDIT')!, ancestors: ['pattern-menu'] }];
    const { driver, ctx, device } = build([base, menu]);
    const result = await driver.triggerDOM(ctx, step({ testKind: 'crud-edit', targetRowId: '5' }));
    expect(result).toBe(true);
    expect(device.taps.map((t) => t.id)).toEqual(['action-overflow', 'action-EDIT']);
  });

  it('control: no overflow in the row means no tap and a missing affordance', async () => {
    const tree = iosTree().filter((e) => e.id !== 'action-EDIT' && e.id !== 'action-overflow');
    const { driver, ctx, device } = build([tree]);
    expect(await driver.triggerDOM(ctx, step({ testKind: 'crud-edit', targetRowId: '5' }))).toBe('no-row-affordance');
    expect(device.taps).toEqual([]);
  });

  it('crud-delete with no button dispatches the row payload through the bridge', async () => {
    const tree = iosTree().filter((e) => !e.id.includes('DELETE') && e.id !== 'action-EDIT' && e.id !== 'action-overflow');
    const { driver, ctx, bridge } = build([tree]);
    bridge.entityRows.Task = [{ id: '5', title: 'Eggs' }, { id: '3', title: 'Milk' }];
    const result = await driver.triggerDOM(
      ctx,
      step({ event: 'DELETE', testKind: 'crud-delete', targetRowId: '5', expectedRowDelta: { entityName: 'Task', delta: -1 } }),
      'Tasks.TaskBrowse',
    );
    expect(result).toBe(true);
    expect(bridge.sent).toEqual([{ event: 'DELETE', payload: { id: '5' }, traitScope: 'TaskBrowse' }]);
  });

  it('control: the delete payload fallback picks the lowest id when no target row is named', async () => {
    const tree = iosTree().filter((e) => !e.id.includes('DELETE') && e.id !== 'action-EDIT' && e.id !== 'action-overflow');
    const { driver, ctx, bridge } = build([tree]);
    bridge.entityRows.Task = [{ id: '5' }, { id: '3' }];
    await driver.triggerDOM(ctx, step({ event: 'DELETE', testKind: 'crud-delete', expectedRowDelta: { entityName: 'Task', delta: -1 } }));
    expect(bridge.sent[0]?.payload).toEqual({ id: '3' });
  });

  it('an unusable (refused) tap does not count as delivered', async () => {
    const { driver, ctx } = build([iosTree()], { refuse: ['action-CREATE'] });
    expect(await driver.triggerDOM(ctx, step({ event: 'CREATE', triggerKind: 'dom' }))).toBe(false);
  });
});

describe('triggerDOM forms', () => {
  it('fills formData through field-<name> ids after opening the form', async () => {
    const { driver, ctx, device } = build([iosTree()]);
    await driver.triggerDOM(ctx, step({ event: 'CREATE', formData: { title: 'Buy milk' } }));
    expect(device.taps[0]?.id).toBe('action-CREATE');
    expect(device.typed).toEqual([{ id: 'field-title', text: 'Buy milk' }]);
  });

  it('skips a null value and an object value; control: the scalar is still typed', async () => {
    const { driver, ctx, device } = build([iosTree()]);
    await driver.triggerDOM(ctx, step({ event: 'CREATE', formData: { title: 'x', notes: null } }));
    expect(device.typed.map((t) => t.id)).toEqual(['field-title']);
  });

  it('fills the owning form before tapping its own submit, and not for a malformed probe', async () => {
    const filled = build([iosTree()]);
    await filled.driver.triggerDOM(filled.ctx, step({ event: 'SAVE' }));
    expect(filled.device.typed.map((t) => t.id)).toEqual(['field-title', 'field-notes']);
    expect(filled.device.taps.map((t) => t.id)).toEqual(['action-SAVE', 'action-SAVE']);

    const malformed = build([iosTree()]);
    await malformed.driver.triggerDOM(malformed.ctx, step({ event: 'SAVE', payloadCase: 'malformed' }));
    expect(malformed.device.typed).toEqual([]);
  });

  it('a crud step taps its submit event after the open and waits for the success event', async () => {
    const { driver, ctx, device, bridge } = build([iosTree()]);
    bridge.snapshotValue = {
      traits: [],
      transitionsDropped: 0,
      route: null,
      transitions: [],
    };
    const landing = {
      id: 't-1', traitName: 'server:Tasks', from: 'a', to: 'a', event: 'TASK_SAVED', effects: [], timestamp: 1,
      serverResponse: { orbitalName: 'Tasks', success: true, transitioned: true, clientEffects: 0, dataEntities: {}, emittedEvents: ['TASK_SAVED'], timestamp: 1 },
    };
    const original = bridge.snapshot.bind(bridge);
    let calls = 0;
    bridge.snapshot = async () => {
      calls++;
      return calls < 3 ? await original() : { traits: [], transitionsDropped: 0, route: null, transitions: [landing] };
    };
    bridge.entityRows.Task = [];
    const result = await driver.triggerDOM(
      ctx,
      step({ event: 'CREATE', testKind: 'crud-create', submitEvent: 'SAVE', expectedSuccessEvent: 'TASK_SAVED', payloadCase: 'malformed' }),
    );
    expect(result).toBe(true);
    expect(device.taps.map((t) => t.id)).toEqual(['action-CREATE', 'action-SAVE']);
  });
});

describe('sendEvent / getState / listEntityRows', () => {
  it('reports sent for a 202 and not sent for a 409', async () => {
    const { driver, ctx, bridge } = build([iosTree()]);
    expect((await driver.sendEvent(ctx, 'INIT', {}, 'Tasks.TaskBrowse')).sent).toBe(true);
    bridge.sendStatus = 409;
    expect((await driver.sendEvent(ctx, 'INIT', {})).sent).toBe(false);
    expect(bridge.sent[0]?.traitScope).toBe('TaskBrowse');
    expect(bridge.sent[1]?.traitScope).toBe('TaskBrowse');
  });

  it('reads trait state and entity rows from the bridge', async () => {
    const { driver, ctx, bridge } = build([iosTree()]);
    bridge.states.TaskBrowse = 'listing';
    bridge.entityRows.Task = [{ id: '1' }];
    expect(await driver.getState(ctx, 'TaskBrowse')).toBe('listing');
    expect(await driver.getState(ctx, 'Other')).toBeNull();
    expect(await driver.listEntityRows?.(ctx, 'Task')).toEqual([{ id: '1' }]);
  });
});

describe('settle', () => {
  it('returns once the bridge is idle for the stable reads', async () => {
    const { driver, ctx } = build([iosTree()]);
    await driver.settle(ctx);
    expect(driver.diagnostics.settleTimeouts).toEqual([]);
  });

  it('waits through a busy bridge, then settles; control: no timeout is recorded', async () => {
    const { driver, ctx, bridge } = build([iosTree()]);
    bridge.idleAnswers = [
      { idle: false, ready: true, pending: 1, queuedSends: 0 },
      { idle: false, ready: true, pending: 1, queuedSends: 0 },
      { idle: true, ready: true, pending: 0, queuedSends: 0 },
    ];
    await driver.settle(ctx);
    expect(driver.diagnostics.settleTimeouts).toEqual([]);
  });

  it('records a timeout when pending never drains, instead of swallowing it', async () => {
    const { driver, ctx, bridge } = build([iosTree()]);
    bridge.idleAnswers = [{ idle: false, ready: true, pending: 1, queuedSends: 0 }];
    await driver.settle(ctx);
    expect(driver.diagnostics.settleTimeouts).toHaveLength(1);
    expect(driver.diagnostics.settleTimeouts[0]).toMatchObject({ trait: 'TaskBrowse', pending: 1, queuedSends: 0 });
  });

  it('a single idle blip between busy reads does not settle early', async () => {
    const { driver, ctx, bridge } = build([iosTree()]);
    bridge.idleAnswers = [
      { idle: true, ready: true, pending: 0, queuedSends: 0 },
      { idle: false, ready: true, pending: 1, queuedSends: 0 },
      { idle: false, ready: true, pending: 1, queuedSends: 0 },
    ];
    await driver.settle(ctx);
    expect(driver.diagnostics.settleTimeouts).toHaveLength(1);
  });
});

describe('readiness after a relaunch', () => {
  const unready = { idle: false, ready: false, pending: 0, queuedSends: 0 };
  const ready = { idle: true, ready: true, pending: 0, queuedSends: 0 };

  it('beforeTrait waits for the host to report ready before returning; control: no timeout is recorded', async () => {
    const { driver, ctx, bridge } = build([iosTree()]);
    bridge.idleAnswers = [unready, unready, ready];
    await driver.beforeTrait!(ctx);
    expect(bridge.idleReads).toBe(5);
    expect(driver.diagnostics.readyTimeouts).toEqual([]);
  });

  it('reset waits for ready too', async () => {
    const { driver, ctx, bridge } = build([iosTree()]);
    bridge.idleAnswers = [unready, ready];
    await driver.reset(ctx);
    expect(bridge.idleReads).toBe(4);
    expect(driver.diagnostics.readyTimeouts).toEqual([]);
  });

  it('records a ready timeout in diagnostics instead of swallowing it', async () => {
    const { driver, ctx, bridge } = build([iosTree()]);
    bridge.idleAnswers = [unready];
    await driver.beforeTrait!(ctx);
    expect(driver.diagnostics.readyTimeouts).toHaveLength(1);
    expect(driver.diagnostics.readyTimeouts[0]).toMatchObject({ trait: 'TaskBrowse' });
  });

  it('a ready host with work still pending is ready, but the relaunch then waits for the pending legs', async () => {
    const { driver, ctx, bridge } = build([iosTree()]);
    bridge.idleAnswers = [{ idle: false, ready: true, pending: 2, queuedSends: 0 }];
    await driver.beforeTrait!(ctx);
    expect(driver.diagnostics.readyTimeouts).toEqual([]);
    expect(driver.diagnostics.settleTimeouts).toHaveLength(1);
    expect(driver.diagnostics.settleTimeouts[0]).toMatchObject({ pending: 2 });
  });

  it('beforeTrait returns only after the mount INIT legs drain (a step sent earlier would hit the pre-cascade state); control: no timeout', async () => {
    const { driver, ctx, bridge } = build([iosTree()]);
    const busy = { idle: false, ready: true, pending: 1, queuedSends: 0 };
    const idle = { idle: true, ready: true, pending: 0, queuedSends: 0 };
    bridge.idleAnswers = [busy, busy, busy, idle, idle];
    await driver.beforeTrait!(ctx);
    expect(bridge.idleReads).toBe(5);
    expect(driver.diagnostics.settleTimeouts).toEqual([]);
  });

  it('reset drains the mount legs too', async () => {
    const { driver, ctx, bridge } = build([iosTree()]);
    const busy = { idle: false, ready: true, pending: 1, queuedSends: 0 };
    const idle = { idle: true, ready: true, pending: 0, queuedSends: 0 };
    bridge.idleAnswers = [busy, idle, idle];
    await driver.reset(ctx);
    expect(bridge.idleReads).toBe(3);
  });

  it('settle does not return while the host is unready even though pending is 0', async () => {
    const { driver, ctx, bridge } = build([iosTree()]);
    bridge.idleAnswers = [unready];
    await driver.settle(ctx);
    expect(driver.diagnostics.settleTimeouts).toHaveLength(1);
    expect(driver.diagnostics.settleTimeouts[0]).toMatchObject({ ready: false, pending: 0 });
  });
});

describe('reset', () => {
  it('relaunches, waits for /health, and restarts the event cursor', async () => {
    const { driver, ctx, device, bridge } = build([iosTree()]);
    bridge.eventPages = [{ entries: [], next: 7, dropped: 0 }];
    await driver.snapshot(ctx, null);
    bridge.healthAnswers = [false, false, true];
    await driver.reset(ctx);
    await driver.snapshot(ctx, null);
    expect(device.relaunches).toBe(1);
    expect(bridge.eventSinceCalls).toEqual([0, 0]);
  });

  it('fails loudly when the bridge never comes back', async () => {
    const { driver, ctx, bridge } = build([iosTree()]);
    bridge.healthAnswers = [false];
    await expect(driver.reset(ctx)).rejects.toThrow(/did not answer \/health/);
  });
});

describe('beforeTrait and route-pinned reset', () => {
  const routed = (route?: string) => ({ ...trait, ...(route !== undefined && { route }) });

  it('beforeTrait relaunches with the trait route and waits for the bridge to report it', async () => {
    const { driver, device, bridge, ctx } = build([iosTree()]);
    bridge.routeAnswers = ['/notes', '/notes', '/notes/tags'];
    await driver.beforeTrait!({ ...ctx, trait: routed('/notes/tags') });
    expect(device.relaunchEnvs).toEqual([{ ORBITAL_INITIAL_ROUTE: '/notes/tags' }]);
    expect(driver.diagnostics.routeTimeouts).toEqual([]);
  });

  it('a route without a leading slash is normalized exactly as the web goto does, for the env and the comparison', async () => {
    const { driver, device, bridge, ctx } = build([iosTree()]);
    bridge.routeAnswers = ['/notes/tags'];
    await driver.beforeTrait!({ ...ctx, trait: routed('notes/tags') });
    expect(device.relaunchEnvs).toEqual([{ ORBITAL_INITIAL_ROUTE: '/notes/tags' }]);
    expect(driver.diagnostics.routeTimeouts).toEqual([]);
  });

  it('control: a bridge route lacking the slash is not accepted as the slashed route', async () => {
    const { driver, bridge, ctx } = build([iosTree()]);
    bridge.routeAnswers = ['notes/tags'];
    await driver.beforeTrait!({ ...ctx, trait: routed('/notes/tags') });
    expect(driver.diagnostics.routeTimeouts).toHaveLength(1);
  });

  it('reset relaunches at the same route so a reset stays on the trait page', async () => {
    const { driver, device, bridge, ctx } = build([iosTree()]);
    bridge.routeAnswers = ['/notes/tags'];
    await driver.reset({ ...ctx, trait: routed('/notes/tags') });
    expect(device.relaunchEnvs).toEqual([{ ORBITAL_INITIAL_ROUTE: '/notes/tags' }]);
  });

  it('a param route is passed verbatim and compared verbatim', async () => {
    const { driver, device, bridge, ctx } = build([iosTree()]);
    bridge.routeAnswers = ['/notes/:id'];
    await driver.beforeTrait!({ ...ctx, trait: routed('/notes/:id') });
    expect(device.relaunchEnvs).toEqual([{ ORBITAL_INITIAL_ROUTE: '/notes/:id' }]);
    expect(driver.diagnostics.routeTimeouts).toEqual([]);
  });

  it('records a route mismatch timeout in diagnostics instead of swallowing it', async () => {
    const { driver, bridge, ctx } = build([iosTree()]);
    bridge.routeAnswers = ['/notes'];
    await driver.beforeTrait!({ ...ctx, trait: routed('/notes/tags') });
    expect(driver.diagnostics.routeTimeouts).toHaveLength(1);
    expect(driver.diagnostics.routeTimeouts[0]).toMatchObject({ trait: 'TaskBrowse', expected: '/notes/tags', actual: '/notes' });
  });

  it('a bridge that reports no route is recorded with a null actual', async () => {
    const { driver, bridge, ctx } = build([iosTree()]);
    bridge.routeAnswers = [null];
    await driver.beforeTrait!({ ...ctx, trait: routed('/notes') });
    expect(driver.diagnostics.routeTimeouts[0]?.actual).toBeNull();
  });

  it('control: a trait with no route relaunches without the env and never polls the route', async () => {
    const { driver, device, bridge, ctx } = build([iosTree()]);
    bridge.routeAnswers = ['/never-read'];
    await driver.beforeTrait!(ctx);
    await driver.reset({ ...ctx, trait: routed('') });
    expect(device.relaunchEnvs).toEqual([undefined, undefined]);
    expect(driver.diagnostics.routeTimeouts).toEqual([]);
  });
});

describe('snapshot', () => {
  it('assembles runtime, dom, events, entities and the frame screenshot', async () => {
    const { driver, ctx, bridge, device } = build([iosTree()]);
    bridge.snapshotValue = {
      traits: [{ traitName: 'TaskBrowse', currentState: 'listing', states: ['listing'], events: ['INIT'] }],
      transitionsDropped: 0,
      route: null,
      transitions: [
        {
          id: 't-1', traitName: 'TaskBrowse', from: 'idle', to: 'listing', event: 'EDIT', timestamp: 2,
          effects: [{ type: 'fetch', entityName: 'Task', args: [], status: 'executed' }],
        },
      ],
    };
    bridge.eventPages = [{ entries: [{ type: 'UI:EDIT', timestamp: 3 }], next: 1, dropped: 0 }];
    bridge.entityRows.Task = [{ id: '3' }, { id: '5' }];
    const snap = await driver.snapshot(ctx, step({ event: 'EDIT' }));
    expect(snap.runtimeSnapshot.traits[0]).toMatchObject({ traitName: 'TaskBrowse', currentState: 'listing', cascadeReceived: [] });
    expect(snap.runtimeSnapshot.traits[0]?.data.Task).toHaveLength(2);
    expect(snap.entityData.Task).toHaveLength(2);
    expect(snap.dom.rowsByEntity).toEqual({ Task: 2 });
    expect(snap.dom.url).toBe('');
    expect(snap.dom.portals.every((p) => !p.mounted)).toBe(true);
    expect(snap.effectResults).toHaveLength(1);
    expect(snap.eventLogAdded).toHaveLength(1);
    expect(snap.screenshotPath).toBe(device.screenshots[0]);
    expect(snap.screenshotPath?.endsWith('.png')).toBe(true);
    expect(snap.screenshotPath).toContain('/frames/');
  });

  it('derives the portals from slot containers: an open modal mounts, a closed one does not', async () => {
    const open = build([iosSlotTree('modal-open')]);
    const closed = build([iosSlotTree('modal-closed')]);
    const openSnap = await open.driver.snapshot(open.ctx, null);
    const closedSnap = await closed.driver.snapshot(closed.ctx, null);
    expect(openSnap.dom.portals.find((p) => p.slot === 'modal')).toMatchObject({ mounted: true, childCount: 1, pattern: 'form-section' });
    expect(closedSnap.dom.portals.find((p) => p.slot === 'modal')).toEqual({ slot: 'modal', mounted: false, childCount: 0 });
  });

  it('sets the dom url from the bridge route and records no diagnostic', async () => {
    const { driver, ctx, bridge } = build([iosTree()]);
    bridge.snapshotValue = { ...bridge.snapshotValue, route: '/tasks/3' };
    const snap = await driver.snapshot(ctx, null);
    expect(snap.dom.url).toBe('/tasks/3');
    expect(driver.diagnostics.routeUnavailable).toBe(0);
  });

  it('control: a null route gives an empty url and a counted diagnostic, never a guess', async () => {
    const { driver, ctx, bridge } = build([iosTree()]);
    bridge.snapshotValue = { ...bridge.snapshotValue, route: null };
    await driver.snapshot(ctx, null);
    const snap = await driver.snapshot(ctx, null);
    expect(snap.dom.url).toBe('');
    expect(driver.diagnostics.routeUnavailable).toBe(2);
  });

  describe('server-leg-failed', () => {
    const failed = (event: string) => ({
      type: 'server-leg-failed',
      payload: { orbital: 'Tasks', event, error: 'connection refused' },
      timestamp: 9,
    });

    it('surfaces the failed round trip of the stepped event as an unsuccessful serverResponse', async () => {
      const { driver, ctx, bridge } = build([iosTree()]);
      bridge.eventPages = [{ entries: [failed('SAVE')], next: 1, dropped: 0 }];
      const snap = await driver.snapshot(ctx, step({ event: 'SAVE' }));
      expect(snap.serverResponse).toMatchObject({ orbitalName: 'Tasks', success: false, transitioned: false, error: 'connection refused', timestamp: 9 });
    });

    it('turns an otherwise successful server response into a failure', async () => {
      const { driver, ctx, bridge } = build([iosTree()]);
      bridge.snapshotValue = {
        ...bridge.snapshotValue,
        transitions: [{
          id: 't', traitName: 'TaskBrowse', from: 'a', to: 'a', event: 'SAVE', effects: [], timestamp: 1,
          serverResponse: { orbitalName: 'Tasks', success: true, transitioned: true, clientEffects: 0, dataEntities: {}, emittedEvents: ['X'], timestamp: 1 },
        }],
      };
      bridge.eventPages = [{ entries: [failed('SAVE')], next: 1, dropped: 0 }];
      const snap = await driver.snapshot(ctx, step({ event: 'SAVE' }));
      expect(snap.serverResponse).toMatchObject({ success: false, error: 'connection refused', emittedEvents: ['X'] });
    });

    it('control: a failure for another event leaves this frame without a serverResponse', async () => {
      const { driver, ctx, bridge } = build([iosTree()]);
      bridge.eventPages = [{ entries: [failed('DELETE')], next: 1, dropped: 0 }];
      const snap = await driver.snapshot(ctx, step({ event: 'SAVE' }));
      expect(snap.serverResponse).toBeNull();
    });

    it('control: no failure entry keeps the response null', async () => {
      const { driver, ctx } = build([iosTree()]);
      expect((await driver.snapshot(ctx, step({ event: 'SAVE' }))).serverResponse).toBeNull();
    });

    it('records a server-leg-failed entry whose payload does not fit, and does not surface it', async () => {
      const { driver, ctx, bridge } = build([iosTree()]);
      bridge.eventPages = [{ entries: [{ type: 'server-leg-failed', payload: { event: 'SAVE' }, timestamp: 1 }], next: 1, dropped: 0 }];
      const snap = await driver.snapshot(ctx, step({ event: 'SAVE' }));
      expect(snap.serverResponse).toBeNull();
      expect(driver.diagnostics.bridgeFailures).toHaveLength(1);
    });

    it('keeps the entry in the frame event log as well', async () => {
      const { driver, ctx, bridge } = build([iosTree()]);
      bridge.eventPages = [{ entries: [failed('SAVE')], next: 1, dropped: 0 }];
      const snap = await driver.snapshot(ctx, step({ event: 'SAVE' }));
      expect(snap.eventLogAdded.map((e) => e.type)).toEqual(['server-leg-failed']);
    });
  });

  it('advances the event cursor so the next snapshot only asks for newer entries', async () => {
    const { driver, ctx, bridge } = build([iosTree()]);
    bridge.eventPages = [
      { entries: [], next: 4, dropped: 0 },
      { entries: [], next: 6, dropped: 0 },
    ];
    await driver.snapshot(ctx, null);
    await driver.snapshot(ctx, null);
    expect(bridge.eventSinceCalls).toEqual([0, 4]);
  });

  it('control: no screenshot for the auto-init (null step) frame', async () => {
    const { driver, ctx, device } = build([iosTree()]);
    const snap = await driver.snapshot(ctx, null);
    expect(snap.screenshotPath).toBeNull();
    expect(device.screenshots).toEqual([]);
  });

  it('records, not hides, a tree read failure', async () => {
    const device = new FakeDevice([iosTree()]);
    device.readTree = async () => {
      throw new Error('xcuitest snapshot failed');
    };
    const bridge = new FakeBridge();
    const driver = createNativeDriver({ device, bridge, entityNames: [], ...fakeClock() });
    const snap = await driver.snapshot({ outputDir: mkdtempSync(join(tmpdir(), 'nd-')), trait }, null);
    expect(snap.dom.portals.every((p) => !p.mounted)).toBe(true);
    expect(driver.diagnostics.treeFailures).toEqual(['xcuitest snapshot failed']);
  });
});
