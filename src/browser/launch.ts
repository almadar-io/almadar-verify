/**
 * Browser launch with shared defaults.
 *
 * @packageDocumentation
 */

import { chromium, type Browser, type BrowserContext, type Worker } from 'playwright';

export interface LaunchOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  timeout?: number;
}

const DEFAULTS: Required<LaunchOptions> = {
  headless: true,
  viewport: { width: 1440, height: 900 },
  timeout: 30000,
};

/**
 * Launch a Chromium browser with shared defaults.
 * Returns both the browser and a context with the configured viewport.
 */
export async function launchBrowser(
  options?: LaunchOptions
): Promise<{ browser: Browser; context: BrowserContext }> {
  const opts = { ...DEFAULTS, ...options };

  const browser = await chromium.launch({
    headless: opts.headless,
  });

  const context = await browser.newContext({
    viewport: opts.viewport,
    reducedMotion: 'reduce',
  });

  context.setDefaultTimeout(opts.timeout);

  return { browser, context };
}

export interface ExtensionLaunchOptions extends LaunchOptions {
  /** Unpacked extension directories (each holding a `manifest.json`) to load. */
  extensions: readonly string[];
  /** Extra Chromium command-line switches. */
  args?: readonly string[];
  /**
   * `chrome` runs the installed Google Chrome instead of Playwright's Chromium. It ignores
   * `--load-extension`, so the extensions are loaded over DevTools (`Extensions.loadUnpacked`).
   */
  channel?: 'chromium' | 'chrome';
  /** The profile directory to run in; absent runs a temporary one. */
  userDataDir?: string;
  /**
   * Keep Chrome's on-device model (the Prompt API) running: Playwright's default switches disable
   * `OptimizationHints`, which the model service needs. Needs `channel: 'chrome'` and a profile that
   * holds the model.
   */
  onDeviceModel?: boolean;
}

/** Playwright's default `--disable-features` list without `OptimizationHints`; a later `--disable-features` replaces the earlier one. */
const FEATURES_DISABLED_WITH_MODEL = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'BoundaryEventDispatchTracksNodeRemoval',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'Translate',
  'AutoDeElevate',
  'RenderDocument',
];

/**
 * Launch Chromium (or the installed Chrome) with unpacked extensions loaded. Extensions need a
 * persistent profile, so this returns only a context. `extensionIds` are the loaded extensions' ids
 * when the browser reports them up front (Chrome); in Chromium they come from `extensionWorker`.
 */
export async function launchBrowserWithExtensions(
  options: ExtensionLaunchOptions
): Promise<{ context: BrowserContext; extensionIds: string[] }> {
  if (options.extensions.length === 0) {
    throw new Error('launchBrowserWithExtensions needs at least one unpacked extension directory');
  }
  const channel = options.channel ?? 'chromium';
  if (options.onDeviceModel === true && channel !== 'chrome') {
    throw new Error("the on-device model runs only in the installed Google Chrome (channel 'chrome')");
  }
  const opts = { ...DEFAULTS, ...options };
  const list = options.extensions.join(',');
  const switches = channel === 'chrome'
    ? ['--enable-unsafe-extension-debugging', ...(options.onDeviceModel === true ? [`--disable-features=${FEATURES_DISABLED_WITH_MODEL.join(',')}`] : [])]
    : [`--disable-extensions-except=${list}`, `--load-extension=${list}`];
  const context = await chromium.launchPersistentContext(options.userDataDir ?? '', {
    channel,
    headless: opts.headless,
    viewport: opts.viewport,
    reducedMotion: 'reduce',
    ...(channel === 'chrome' ? { ignoreDefaultArgs: ['--disable-extensions'] } : {}),
    args: [...switches, ...(options.args ?? [])],
  });
  context.setDefaultTimeout(opts.timeout);
  if (channel === 'chromium') return { context, extensionIds: [] };
  try {
    const browser = context.browser();
    if (!browser) throw new Error('the installed Chrome exposed no browser session to load extensions through');
    const devtools = await browser.newBrowserCDPSession();
    const extensionIds: string[] = [];
    for (const path of options.extensions) extensionIds.push((await devtools.send('Extensions.loadUnpacked', { path })).id);
    return { context, extensionIds };
  } catch (err) {
    await context.close();
    throw err;
  }
}

const isExtensionWorker = (w: Worker) => w.url().startsWith('chrome-extension://');

/**
 * The loaded extension's service worker and the extension id its pages are served under: the one
 * with `extensionId` when given (Chrome runs its own extensions' workers too), else the first.
 */
export async function extensionWorker(
  context: BrowserContext,
  options?: { timeout?: number; extensionId?: string }
): Promise<{ worker: Worker; extensionId: string }> {
  const wanted = options?.extensionId;
  const matches = (w: Worker) => (wanted !== undefined ? w.url().startsWith(`chrome-extension://${wanted}/`) : isExtensionWorker(w));
  let worker = context.serviceWorkers().find(matches);
  if (!worker) {
    const timeout = options?.timeout ?? DEFAULTS.timeout;
    worker = await context
      .waitForEvent('serviceworker', { predicate: matches, timeout })
      .catch(() => {
        throw new Error(`no extension service worker started within ${timeout}ms`);
      });
  }
  return { worker, extensionId: new URL(worker.url()).host };
}
