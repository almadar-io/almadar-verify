import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIosDevice } from '../ios.js';
import { createAndroidDevice, escapeAdbInputText, centreOf, type AdbExec } from '../android.js';
import type { HttpClient, HttpResponse } from '../bridge.js';
import { parseAndroidDump, type NativeElement } from '../tree.js';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dumpXml = readFileSync(join(here, '..', '__fixtures__', 'android-dump.xml'), 'utf8');
const iosJson = readFileSync(join(here, '..', '__fixtures__', 'ios-tree.json'), 'utf8');

function el(over: Partial<NativeElement>): NativeElement {
  return { id: 'field-title', type: 'textField', label: '', value: '', bounds: { x: 10, y: 20, w: 100, h: 40 }, enabled: true, hittable: true, ancestors: [], ...over };
}

function fakeHttp(respond: (method: string, url: string, body?: string) => HttpResponse, png = new Uint8Array([137, 80, 78, 71])): { http: HttpClient; calls: Array<{ method: string; url: string; body?: string }> } {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  return {
    calls,
    http: {
      async request(method, url, body) {
        calls.push({ method, url, ...(body !== undefined && { body }) });
        return respond(method, url, body);
      },
      async requestBytes() {
        return png;
      },
    },
  };
}

describe('ios device', () => {
  it('reads and parses /tree', async () => {
    const { http, calls } = fakeHttp(() => ({ status: 200, text: iosJson }));
    const tree = await createIosDevice({ http, driverPort: 7358 }).readTree();
    expect(calls[0]?.url).toBe('http://127.0.0.1:7358/tree');
    expect(tree.some((e) => e.id === 'action-CREATE')).toBe(true);
  });

  it('taps by id with the row scope and reports false on a 404', async () => {
    const present = fakeHttp(() => ({ status: 200, text: '{"ok":true}' }));
    expect(await createIosDevice({ http: present.http, driverPort: 1 }).tap(el({ id: 'action-EDIT' }), 'row-5')).toBe(true);
    expect(JSON.parse(present.calls[0]!.body!)).toEqual({ id: 'action-EDIT', within: 'row-5' });

    const absent = fakeHttp(() => ({ status: 404, text: '{"error":"action-EDIT not found"}' }));
    expect(await createIosDevice({ http: absent.http, driverPort: 1 }).tap(el({ id: 'action-EDIT' }))).toBe(false);
  });

  it('reports false for a not-hittable 409; a server error throws', async () => {
    const busy = fakeHttp(() => ({ status: 409, text: '{"error":"element exists but is not hittable"}' }));
    expect(await createIosDevice({ http: busy.http, driverPort: 1 }).tap(el({}))).toBe(false);
    const broken = fakeHttp(() => ({ status: 500, text: 'boom' }));
    await expect(createIosDevice({ http: broken.http, driverPort: 1 }).tap(el({}))).rejects.toThrow(/500/);
  });

  it('clears existing content with delete keys before typing', async () => {
    const { http, calls } = fakeHttp(() => ({ status: 200, text: '{}' }));
    const device = createIosDevice({ http, driverPort: 1 });
    await device.typeText(el({ value: 'abc' }), 'new');
    expect(JSON.parse(calls[0]!.body!).text).toBe('\u0008\u0008\u0008new');
    await device.typeText(el({ value: '' }), 'new');
    expect(JSON.parse(calls[1]!.body!).text).toBe('new');
  });

  it('writes the screenshot bytes, creating the directory', async () => {
    const { http } = fakeHttp(() => ({ status: 200, text: '' }));
    const out = join(mkdtempSync(join(tmpdir(), 'ios-shot-')), 'frames', 'a.png');
    await createIosDevice({ http, driverPort: 1 }).screenshot(out);
    expect([...readFileSync(out)]).toEqual([137, 80, 78, 71]);
  });

  it('relaunch posts /relaunch', async () => {
    const { http, calls } = fakeHttp(() => ({ status: 200, text: '{"ok":true}' }));
    await createIosDevice({ http, driverPort: 1 }).relaunch();
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://127.0.0.1:1/relaunch', body: '{}' });
  });

  it('relaunch with an env posts it as {env} for the driver to merge', async () => {
    const { http, calls } = fakeHttp(() => ({ status: 200, text: '{"ok":true}' }));
    await createIosDevice({ http, driverPort: 1 }).relaunch({ ORBITAL_INITIAL_ROUTE: '/notes' });
    expect(JSON.parse(calls[0]!.body ?? '')).toEqual({ env: { ORBITAL_INITIAL_ROUTE: '/notes' } });
  });
});

class FakeAdb implements AdbExec {
  runs: string[][] = [];
  constructor(private readonly out: string = '') {}
  async run(args: ReadonlyArray<string>): Promise<string> {
    this.runs.push([...args]);
    return this.out;
  }
  async runBinary(args: ReadonlyArray<string>): Promise<Uint8Array> {
    this.runs.push([...args]);
    return new Uint8Array([1, 2, 3]);
  }
}

describe('android device', () => {
  it('dumps via exec-out and strips the trailer after the hierarchy', async () => {
    const adb = new FakeAdb(`${dumpXml}UI hierchary dumped to: /dev/tty\n`);
    const tree = await createAndroidDevice({ adb, relaunchApp: async () => undefined }).readTree();
    expect(adb.runs[0]).toEqual(['exec-out', 'uiautomator', 'dump', '/dev/tty']);
    expect(tree.find((e) => e.id === 'action-CREATE')).toBeDefined();
  });

  it('fails loudly when the dump has no hierarchy', async () => {
    const adb = new FakeAdb('ERROR: could not get idle state.');
    await expect(createAndroidDevice({ adb, relaunchApp: async () => undefined }).readTree()).rejects.toThrow(/no hierarchy/);
  });

  it('taps the centre of the bounds', async () => {
    const adb = new FakeAdb();
    const target = parseAndroidDump(dumpXml).find((e) => e.id === 'action-CREATE')!;
    expect(centreOf(target)).toEqual({ x: 220, y: 1660 });
    expect(await createAndroidDevice({ adb, relaunchApp: async () => undefined }).tap(target)).toBe(true);
    expect(adb.runs[0]).toEqual(['shell', 'input', 'tap', '220', '1660']);
  });

  it('control: a disabled element is not tapped', async () => {
    const adb = new FakeAdb();
    const disabled = parseAndroidDump(dumpXml).find((e) => e.id === 'action-ARCHIVE')!;
    expect(await createAndroidDevice({ adb, relaunchApp: async () => undefined }).tap(disabled)).toBe(false);
    expect(adb.runs).toEqual([]);
  });

  it('types after tapping the field, clearing existing text first', async () => {
    const adb = new FakeAdb();
    const device = createAndroidDevice({ adb, relaunchApp: async () => undefined });
    await device.typeText(el({ value: 'ab', bounds: { x: 0, y: 0, w: 10, h: 10 } }), 'hi there');
    expect(adb.runs).toEqual([
      ['shell', 'input', 'tap', '5', '5'],
      ['shell', 'input', 'keyevent', '123', '67', '67'],
      ['shell', 'input', 'text', "'hi%sthere'"],
    ]);
  });

  it('control: an empty field skips the clearing keyevents', async () => {
    const adb = new FakeAdb();
    await createAndroidDevice({ adb, relaunchApp: async () => undefined }).typeText(el({}), 'x');
    expect(adb.runs.map((r) => r[2])).toEqual(['tap', 'text']);
  });

  it('screenshots through exec-out screencap and relaunches through the orchestrator hook', async () => {
    const adb = new FakeAdb();
    let relaunched = 0;
    const device = createAndroidDevice({ adb, relaunchApp: async () => { relaunched++; } });
    const out = join(mkdtempSync(join(tmpdir(), 'and-shot-')), 'f.png');
    await device.screenshot(out);
    await device.relaunch();
    expect([...readFileSync(out)]).toEqual([1, 2, 3]);
    expect(adb.runs[0]).toEqual(['exec-out', 'screencap', '-p']);
    expect(relaunched).toBe(1);
    const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const withEnv = createAndroidDevice({ adb, relaunchApp: async (env) => { seen.push(env); } });
    await withEnv.relaunch({ ORBITAL_INITIAL_ROUTE: '/notes' });
    await withEnv.relaunch();
    expect(seen).toEqual([{ ORBITAL_INITIAL_ROUTE: '/notes' }, undefined]);
  });
});

describe('escapeAdbInputText', () => {
  it('turns spaces into %s and single-quotes the argument', () => {
    expect(escapeAdbInputText('a b')).toBe("'a%sb'");
  });
  it('protects shell metacharacters and embedded single quotes', () => {
    expect(escapeAdbInputText(`it's $x & y`)).toBe(`'it'\\''s%s$x%s&%sy'`);
  });
  it('rejects what input text cannot type instead of altering it', () => {
    expect(() => escapeAdbInputText('50%')).toThrow(/'%'/);
    expect(() => escapeAdbInputText('café')).toThrow(/non-ASCII/);
    expect(() => escapeAdbInputText('a\nb')).toThrow(/control/);
  });
});
