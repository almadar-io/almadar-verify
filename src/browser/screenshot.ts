/**
 * Screenshot capture utilities.
 *
 * @packageDocumentation
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Page, ElementHandle } from 'playwright';

/**
 * Capture a screenshot of a specific element or the full page.
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

    if (selector) {
      const element: ElementHandle | null = await page.$(selector);
      if (element) {
        await element.screenshot({ path: outputPath });
        return outputPath;
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
