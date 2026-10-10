/**
 * Android device over `adb`: `uiautomator dump` for the tree (Compose testTags
 * surface as `resource-id` with `testTagsAsResourceId` on), `input tap` at the
 * centre of an element's bounds, `input text` for fields.
 *
 * @packageDocumentation
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLogger } from '@almadar/logger';
import type { NativeDevice } from './device.js';
import { parseAndroidDump, type NativeElement } from './tree.js';

const log = createLogger('almadar:verify:native:android');

/** The seam over the `adb` binary; each call is one argv (no shell on the host side). */
export interface AdbExec {
  run(args: ReadonlyArray<string>): Promise<string>;
  runBinary(args: ReadonlyArray<string>): Promise<Uint8Array>;
}

/**
 * Quote `text` for `adb shell input text`: spaces become `%s`, and the whole
 * argument is single-quoted for the device shell. `%` (which `input text`
 * reads as an escape), newlines and non-ASCII cannot be typed this way and are
 * rejected rather than silently altered.
 */
export function escapeAdbInputText(text: string): string {
  if (text.includes('%')) throw new Error(`adb input text cannot type a literal '%': ${JSON.stringify(text)}`);
  if (/[^\x20-\x7e]/.test(text)) throw new Error(`adb input text cannot type non-ASCII or control characters: ${JSON.stringify(text)}`);
  return `'${text.replace(/ /g, '%s').replace(/'/g, `'\\''`)}'`;
}

export function centreOf(element: NativeElement): { x: number; y: number } {
  return { x: element.bounds.x + Math.floor(element.bounds.w / 2), y: element.bounds.y + Math.floor(element.bounds.h / 2) };
}

const KEYCODE_MOVE_END = '123';
const KEYCODE_DEL = '67';

export interface AndroidDeviceOptions {
  adb: AdbExec;
  /** Terminate and relaunch the app with its bridge extras; the orchestrator owns package, activity and ports. */
  relaunchApp: (env?: Readonly<Record<string, string>>) => Promise<void>;
}

export function createAndroidDevice(options: AndroidDeviceOptions): NativeDevice {
  const { adb, relaunchApp } = options;

  async function tapElement(element: NativeElement): Promise<boolean> {
    if (!element.hittable) return false;
    const { x, y } = centreOf(element);
    await adb.run(['shell', 'input', 'tap', String(x), String(y)]);
    return true;
  }

  return {
    async readTree() {
      const out = await adb.run(['exec-out', 'uiautomator', 'dump', '/dev/tty']);
      const end = out.lastIndexOf('</hierarchy>');
      if (end < 0) throw new Error(`uiautomator dump produced no hierarchy: ${out}`);
      return parseAndroidDump(out.slice(0, end + '</hierarchy>'.length));
    },
    tap: (element) => tapElement(element),
    async typeText(element, text) {
      if (!(await tapElement(element))) return false;
      if (element.value !== '') {
        await adb.run(['shell', 'input', 'keyevent', KEYCODE_MOVE_END, ...Array.from({ length: element.value.length }, () => KEYCODE_DEL)]);
      }
      if (text !== '') await adb.run(['shell', 'input', 'text', escapeAdbInputText(text)]);
      return true;
    },
    async screenshot(path) {
      const png = await adb.runBinary(['exec-out', 'screencap', '-p']);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, png);
    },
    async relaunch(env) {
      log.debug('android:relaunch', { env });
      await relaunchApp(env);
    },
  };
}
