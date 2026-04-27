/**
 * Screenshot capture utilities.
 *
 * @packageDocumentation
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Page, ElementHandle } from 'playwright';

/**
 * Selectors hidden from every screenshot. Verify mode injects a
 * RuntimeDebugger overlay (`.runtime-debugger`) and a hud-bottom slot
 * portal (`#hud-bottom-portal`); both are diagnostic-only and clutter
 * the captured frame, so we hide them via a stylesheet injected once
 * per Page.
 */
const SCREENSHOT_HIDE_SELECTORS = ['.runtime-debugger', '#hud-bottom-portal'];

/** Per-page idempotency for the hide-stylesheet injection. */
const stylesInjected = new WeakSet<Page>();

async function ensureHideStyles(page: Page): Promise<void> {
  if (stylesInjected.has(page)) return;
  try {
    await page.addStyleTag({
      content: `${SCREENSHOT_HIDE_SELECTORS.join(', ')} { display: none !important; }`,
    });
    stylesInjected.add(page);
  } catch {
    // addStyleTag fails if the page navigated mid-injection. Leave
    // unmarked so the next screenshot retries.
  }
}

/**
 * Capture a screenshot of a specific element or the full page.
 *
 * Hides the verify-mode RuntimeDebugger overlay and hud-bottom portal
 * before capture so screenshots reflect just the app under test.
 *
 * @param page - Playwright page
 * @param outputPath - File path for the screenshot
 * @param selector - Optional CSS selector to screenshot a specific element
 * @returns The actual path where the screenshot was saved, or null on failure
 */
export async function takeScreenshot(
  page: Page,
  outputPath: string,
  selector?: string
): Promise<string | null> {
  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    await ensureHideStyles(page);

    if (selector) {
      const element: ElementHandle | null = await page.$(selector);
      if (element) {
        try {
          await element.screenshot({ path: outputPath });
          return outputPath;
        } catch {
          // Element screenshot failed (e.g., element detached or too large)
          // Fall through to page screenshot
        }
      }
    }

    // Fallback to page screenshot
    await page.screenshot({ path: outputPath, fullPage: false });
    return outputPath;
  } catch {
    return null;
  }
}

/** Sanitize a name for use as a filename */
export function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}
