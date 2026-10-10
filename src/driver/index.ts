/**
 * `driver/` — the kernel's I/O boundary.
 *
 * `Driver<Ctx>` is generic over its runtime context; impls live under
 * `driver/impls/<transport>.ts` and are the only files that import
 * transport libraries (Playwright, Puppeteer, etc.). The kernel itself
 * never names a transport.
 *
 * @packageDocumentation
 */

export type {
  Driver,
  DriverContext,
  SendResult,
  SnapshotResult,
} from './types.js';

export { tick } from './tick.js';

// Impls
export {
  createFakeDriver,
  FakeRuntime,
  type FakeDriverContext,
  type FakeDriverOptions,
} from './impls/fake.js';
export {
  createPlaywrightDriver,
  type PlaywrightDriverContext,
  type PlaywrightBridge,
  type CreatePlaywrightDriverOptions,
} from './impls/playwright.js';

// Helpers (consumers can compose into custom Drivers)
export {
  createDefaultSnapshot,
  type DefaultSnapshotOptions,
} from './helpers/default-snapshot.js';
export {
  createDefaultDomTrigger,
  type DefaultDomTriggerOptions,
} from './helpers/default-dom-trigger.js';
export { createIosDriver, type CreateIosDriverOptions } from './impls/ios.js';
export { createAndroidDriver, type CreateAndroidDriverOptions } from './impls/android.js';
export { createFetchHttpClient, createBridgeClient, type HttpClient, type HttpResponse, type BridgeClient } from './native/bridge.js';
export type { AdbExec } from './native/android.js';
export type { NativeDriver, NativeDriverDiagnostics, RouteTimeout, SettleTimeout } from './native/driver.js';
