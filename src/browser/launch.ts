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
}

/**
 * Launch Chromium with unpacked extensions loaded. Extensions need a persistent profile, so this
 * returns only a context; the profile is temporary and goes away when the context closes.
 */
export async function launchBrowserWithExtensions(
  options: ExtensionLaunchOptions
): Promise<{ context: BrowserContext }> {
  if (options.extensions.length === 0) {
    throw new Error('launchBrowserWithExtensions needs at least one unpacked extension directory');
  }
  const opts = { ...DEFAULTS, ...options };
  const list = options.extensions.join(',');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: opts.headless,
    viewport: opts.viewport,
    reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${list}`, `--load-extension=${list}`, ...(options.args ?? [])],
  });
  context.setDefaultTimeout(opts.timeout);
  return { context };
}

const isExtensionWorker = (w: Worker) => w.url().startsWith('chrome-extension://');

/** The loaded extension's service worker and the extension id its pages are served under. */
export async function extensionWorker(
  context: BrowserContext,
  options?: { timeout?: number }
): Promise<{ worker: Worker; extensionId: string }> {
  let worker = context.serviceWorkers().find(isExtensionWorker);
  if (!worker) {
    const timeout = options?.timeout ?? DEFAULTS.timeout;
    worker = await context
      .waitForEvent('serviceworker', { predicate: isExtensionWorker, timeout })
      .catch(() => {
        throw new Error(`no extension service worker started within ${timeout}ms`);
      });
  }
  return { worker, extensionId: new URL(worker.url()).host };
}
