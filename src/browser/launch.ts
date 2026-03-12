/**
 * Browser launch with shared defaults.
 *
 * @packageDocumentation
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';

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
  });

  context.setDefaultTimeout(opts.timeout);

  return { browser, context };
}
