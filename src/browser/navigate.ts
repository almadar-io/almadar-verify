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
 * Wait for the runtime to load, render content, and expose the verification API.
 * Polls for window.__orbitalVerification and confirms INIT completed.
 * Falls back to a timeout if the API never appears (e.g., simple pages).
 *
 * @param page - Playwright page
 * @param timeoutMs - Maximum time to wait (default: 10000ms)
 */
export async function waitForRuntime(page: Page, timeoutMs = 10000): Promise<void> {
  const pollInterval = 200;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => {
      const api = (window as Window & { __orbitalVerification?: import('@almadar/core').OrbitalVerificationAPI }).__orbitalVerification;
      if (!api?.getSnapshot) return false;
      const snap = api.getSnapshot();
      // Ready when at least one transition has been recorded (INIT fired)
      return snap.transitions.length > 0;
    }).catch(() => false);

    if (ready) return;
    await page.waitForTimeout(pollInterval);
  }

  // Fallback: API never appeared, wait a bit for basic rendering
  await page.waitForTimeout(1000);
}
