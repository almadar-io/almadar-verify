/**
 * Navigation utilities with retry and wait helpers.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import { retry } from '../util/retry.js';

/**
 * Navigate to a URL with retry on failure.
 *
 * @param page - Playwright page
 * @param url - URL to navigate to
 * @param options - Navigation options
 */
export async function navigateWithRetry(
  page: Page,
  url: string,
  options?: {
    waitUntil?: 'domcontentloaded' | 'load' | 'networkidle';
    timeout?: number;
    retries?: number;
  }
): Promise<void> {
  const { waitUntil = 'domcontentloaded', timeout = 15000, retries = 2 } = options ?? {};

  await retry(
    async () => {
      const resp = await page.goto(url, { waitUntil, timeout });
      if (!resp || resp.status() >= 500) {
        throw new Error(`Navigation to ${url} failed with status ${resp?.status()}`);
      }
    },
    retries,
    1000
  );
}

/**
 * Wait for the runtime to load and render content.
 * The OrbitalPreview shows "Loading runtime..." then renders actual content.
 *
 * @param page - Playwright page
 * @param waitMs - Time to wait for runtime to settle (default: 3000ms)
 */
export async function waitForRuntime(page: Page, waitMs = 3000): Promise<void> {
  await page.waitForTimeout(waitMs);
}
