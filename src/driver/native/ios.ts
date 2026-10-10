/**
 * iOS device over the generated `<App>VerifyDriver` XCUITest target
 * (`orb-build.sh --driver`): `GET /tree`, `POST /tap`, `POST /type`,
 * `GET /screenshot`, `POST /relaunch`.
 *
 * @packageDocumentation
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLogger } from '@almadar/logger';
import type { HttpClient } from './bridge.js';
import type { NativeDevice } from './device.js';
import { parseIosTree } from './tree.js';

const log = createLogger('almadar:verify:native:ios');

/** XCUITest's delete key. */
const DELETE_KEY = '\u0008';

export interface IosDeviceOptions {
  http: HttpClient;
  driverPort: number;
  host?: string;
}

export function createIosDevice(options: IosDeviceOptions): NativeDevice {
  const { http, driverPort, host = '127.0.0.1' } = options;
  const base = `http://${host}:${driverPort}`;

  async function post(path: string, body: object): Promise<number> {
    const res = await http.request('POST', `${base}${path}`, JSON.stringify(body));
    if (res.status !== 200 && res.status !== 404 && res.status !== 409) {
      throw new Error(`iOS verify driver POST ${path} -> ${res.status}: ${res.text}`);
    }
    if (res.status !== 200) log.debug('ios:driver:refused', { path, status: res.status, detail: res.text });
    return res.status;
  }

  return {
    async readTree() {
      const res = await http.request('GET', `${base}/tree`);
      if (res.status !== 200) throw new Error(`iOS verify driver GET /tree -> ${res.status}: ${res.text}`);
      return parseIosTree(res.text);
    },
    async tap(element, within) {
      return (await post('/tap', { id: element.id, ...(within !== undefined && { within }) })) === 200;
    },
    async typeText(element, text, within) {
      const clear = DELETE_KEY.repeat(element.value.length);
      return (await post('/type', { id: element.id, text: `${clear}${text}`, ...(within !== undefined && { within }) })) === 200;
    },
    async screenshot(path) {
      const png = await http.requestBytes(`${base}/screenshot`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, png);
    },
    async relaunch(env) {
      await post('/relaunch', env === undefined ? {} : { env });
    },
  };
}
