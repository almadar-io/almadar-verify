/**
 * Screenshot capture utilities.
 *
 * @packageDocumentation
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Page, ElementHandle } from 'playwright';

/* Previous revisions hid `.runtime-debugger` and `#hud-bottom-portal` via
   `page.addStyleTag` + `page.addInitScript({ content: HIDE_CSS })` so the
   diagnostic overlays wouldn't appear in screenshots. That permanent
   stylesheet injection turned out to break interactive page scroll in
   --annotate mode: it landed before the host's layout settled and the
   resulting cascade left page scroll capped at the top of the activity
   log instead of the full content height. Confirmed by patching the
   injector to a no-op locally — scroll worked immediately.

   The injection is removed entirely. Screenshots now include the
   RuntimeDebugger panel when present. If we need to hide it again, do it
   *inside* the same `page.evaluate` that flattens internal scrollers
   and restore it as part of the same snapshot/restore round-trip —
   never via a permanent stylesheet. */

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

    // Fallback to page screenshot. `fullPage: true` only captures
    // `document.documentElement.scrollHeight`, which is bounded by the
    // viewport when the app puts its content inside an inner scrollable
    // container (`<main style="overflow:auto; height:100vh">` and the
    // like). Playwright never sees the overflow because it lives inside
    // the container, not the document.
    //
    // Workaround: before capture, walk the DOM for any element where
    // `overflow{,Y} ∈ {auto,scroll}` AND `scrollHeight > clientHeight`,
    // then temporarily flatten it (`overflow: visible`, `height: auto`,
    // `maxHeight: none`) so its content joins the document flow. After
    // Playwright stitches the screenshot, restore every mutated style.
    // Result: a single PNG that contains the entire scrollable area
    // even when the app uses a `100vh` shell with inner scrollers.
    const restoreSnapshot = await page.evaluate(() => {
      type Snap = { el: Element; style: string };
      const snaps: Snap[] = [];
      // Stash on window IMMEDIATELY so any partial mutation can still be
      // unwound by the restore phase even if walk() throws halfway.
      // Without this, an exception during the walk left body/html in their
      // mutated state (height: auto, min-height: auto, overflow: visible),
      // which blocks page scroll for the rest of the session because the
      // restore phase's `.catch` would silently skip restoration entirely.
      (window as unknown as { __screenshotRestoreSnaps__: Snap[] }).__screenshotRestoreSnaps__ = snaps;
      try {
        const walk = (el: Element): void => {
          try {
            const cs = getComputedStyle(el);
            const overflowsY =
              cs.overflowY === 'auto' || cs.overflowY === 'scroll' ||
              cs.overflow === 'auto' || cs.overflow === 'scroll';
            const e = el as HTMLElement;
            if (overflowsY && e.scrollHeight > e.clientHeight + 4 && e.clientHeight > 0) {
              snaps.push({ el, style: e.getAttribute('style') ?? '' });
              e.style.overflow = 'visible';
              e.style.overflowY = 'visible';
              e.style.height = 'auto';
              e.style.maxHeight = 'none';
            }
          } catch {
            // Elements like <svg>, foreign-object children, or shadow-DOM
            // boundaries can throw on getComputedStyle / scrollHeight; skip
            // them rather than abort the whole walk.
          }
          for (const child of Array.from(el.children)) walk(child);
        };
        const html = document.documentElement;
        const body = document.body;
        // Only flatten html/body when the page is locked to viewport height
        // (e.g. `body { height: 100vh; overflow: hidden }`-style hosts where
        // content lives in an inner scroller). For body-scroll hosts the
        // document already extends past the viewport and Playwright's
        // `fullPage: true` captures it natively — touching the inline styles
        // is unnecessary and risks leaving the body in `min-height: auto`
        // if anything in the walk/restore round-trip mis-fires, which
        // breaks page scroll between walk steps in interactive runs.
        const docScrolls = html.scrollHeight > html.clientHeight + 4
          || body.scrollHeight > body.clientHeight + 4;
        if (!docScrolls) {
          snaps.push({ el: html, style: html.getAttribute('style') ?? '' });
          snaps.push({ el: body, style: body.getAttribute('style') ?? '' });
          html.style.height = 'auto';
          html.style.overflow = 'visible';
          body.style.height = 'auto';
          body.style.minHeight = 'auto';
          body.style.overflow = 'visible';
        }
        walk(html);
      } catch {
        // Any unexpected failure — fall through; the restore phase reads
        // whatever made it into `snaps` and reverts that subset.
      }
      return snaps.length;
    }).catch(() => 0);

    // Take the screenshot; failures here must NOT skip restoration, or
    // body/html stay mutated and break interactive scroll in --annotate
    // mode.
    await page.screenshot({ path: outputPath, fullPage: true }).catch(() => undefined);

    // Always attempt restoration regardless of `restoreSnapshot` count.
    // The mutation evaluate stashes `snaps` on window BEFORE mutating; if
    // it threw mid-walk, partial mutations still need unwinding.
    void restoreSnapshot;
    await page.evaluate(() => {
      const snaps = (window as unknown as { __screenshotRestoreSnaps__?: Array<{ el: Element; style: string }> }).__screenshotRestoreSnaps__;
      if (!snaps) return;
      for (const { el, style } of snaps) {
        try {
          if (style) el.setAttribute('style', style);
          else el.removeAttribute('style');
        } catch {
          // Element may have been detached; skip.
        }
      }
      delete (window as unknown as { __screenshotRestoreSnaps__?: unknown }).__screenshotRestoreSnaps__;
    }).catch(() => undefined);

    return outputPath;
  } catch {
    return null;
  }
}

/** Sanitize a name for use as a filename */
export function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}
