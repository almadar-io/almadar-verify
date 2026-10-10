/**
 * `createIosDriver` — `Driver<Ctx>` for the iOS Simulator: bridge observations
 * plus taps through the generated XCUITest verify driver.
 *
 * @packageDocumentation
 */

import { createBridgeClient, type HttpClient } from '../native/bridge.js';
import { createNativeDriver, type NativeDriver, type NativeDriverOptions } from '../native/driver.js';
import { createIosDevice } from '../native/ios.js';

export interface CreateIosDriverOptions extends Omit<NativeDriverOptions, 'device' | 'bridge'> {
  http: HttpClient;
  /** `ORBITAL_DRIVER_PORT` of the running `<App>VerifyDriver` (default 7358 in `orb-build.sh --driver`). */
  driverPort: number;
  /** `ORBITAL_VERIFY_PORT` of the in-app bridge (default 7357). */
  bridgePort: number;
}

export function createIosDriver(options: CreateIosDriverOptions): NativeDriver {
  const { http, driverPort, bridgePort, ...rest } = options;
  return createNativeDriver({
    ...rest,
    device: createIosDevice({ http, driverPort }),
    bridge: createBridgeClient(http, bridgePort),
  });
}
