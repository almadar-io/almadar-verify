/**
 * `createAndroidDriver` — `Driver<Ctx>` for an Android emulator/device:
 * bridge observations (over `adb forward`) plus taps through `adb`.
 *
 * @packageDocumentation
 */

import { createBridgeClient, type HttpClient } from '../native/bridge.js';
import { createAndroidDevice, type AdbExec } from '../native/android.js';
import { createNativeDriver, type NativeDriver, type NativeDriverOptions } from '../native/driver.js';

export interface CreateAndroidDriverOptions extends Omit<NativeDriverOptions, 'device' | 'bridge'> {
  http: HttpClient;
  adb: AdbExec;
  /** Host port forwarded to the bridge (`adb forward tcp:P tcp:P`). */
  bridgePort: number;
  /** Terminate and relaunch the app with its bridge extras. */
  relaunchApp: (env?: Readonly<Record<string, string>>) => Promise<void>;
}

export function createAndroidDriver(options: CreateAndroidDriverOptions): NativeDriver {
  const { http, adb, bridgePort, relaunchApp, ...rest } = options;
  return createNativeDriver({
    ...rest,
    device: createAndroidDevice({ adb, relaunchApp }),
    bridge: createBridgeClient(http, bridgePort),
  });
}
