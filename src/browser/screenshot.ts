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
 * the captured frame, so we hide them on every navigation.
 */
const SCREENSHOT_HIDE_SELECTORS = ['.runtime-debugger', '#hud-bottom-portal'];

const HIDE_CSS = `${SCREENSHOT_HIDE_SELECTORS.join(', ')} { display: none !important; }`;

/**
 * Per-page tracking of the addInitScript call. WeakSet means we
 * register the init script once per Page; addInitScript itself runs
 * on every subsequent navigation (the canonical Playwright pattern
 * for "always-on" page-level CSS injection).
 *
 * `addStyleTag` was the previous approach but it injects into the
 * current document; navigation throws the document away (and the
 * style tag with it). We were caching "already injected" per Page,
 * so subsequent screenshots after a navigation showed the debugger.
 */
const initScriptRegistered = new WeakSet<Page>();

async function ensureHideStyles(page: Page): Promise<void> {
  // Always (re-)inject into the current document. Cheap, idempotent
  // (multiple identical <style> tags are harmless), and survives the
  // case where the init script hasn't fired yet for the current load.
  try {
    await page.addStyleTag({ content: HIDE_CSS });
  } catch { /* page may be mid-navigation; init script picks up the next load */ }

  if (initScriptRegistered.has(page)) return;
  try {
    await page.addInitScript((css: string) => {
      // Runs on every navigation before any other script. Inject the
      // <style> tag as soon as <head> is available.
      const inject = (): void => {
        if (!document.head) return;
        if (document.getElementById('__verify_hide_styles__')) return;
        const tag = document.createElement('style');
        tag.id = '__verify_hide_styles__';
        tag.textContent = css;
        document.head.appendChild(tag);
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject, { once: true });
      } else {
        inject();
      }
    }, HIDE_CSS);
    initScriptRegistered.add(page);
  } catch { /* best-effort */ }
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
