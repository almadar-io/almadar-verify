/**
 * Screenshot capture utilities.
 *
 * @packageDocumentation
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
 * Flatten every scrollable container into the document flow so a capture
 * sees the full scrollable area.
 *
 * `fullPage: true` only captures `document.documentElement.scrollHeight`,
 * which is bounded by the viewport when the app puts its content inside an
 * inner scrollable container (`<main style="overflow:auto; height:100vh">`
 * and the like). Playwright never sees the overflow because it lives inside
 * the container, not the document.
 *
 * Workaround: before capture, walk the DOM for any element where
 * `overflow{,Y} ∈ {auto,scroll}` AND `scrollHeight > clientHeight`, then
 * temporarily flatten it (`overflow: visible`, `height: auto`,
 * `maxHeight: none`) so its content joins the document flow. Restore with
 * {@link restoreScrollersAfterCapture} once the capture round is done.
 */
async function flattenScrollersForCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Snap = { el: Element; style: string };
    const snaps: Snap[] = [];
    // Stash on window IMMEDIATELY so any partial mutation can still be
    // unwound by the restore phase even if walk() throws halfway.
    // Without this, an exception during the walk left body/html in their
    // mutated state (height: auto, min-height: auto, overflow: visible),
    // which blocks page scroll for the rest of the session because the
    // restore phase's `.catch` would silently skip restoration entirely.
    (window as Window & { __screenshotRestoreSnaps__?: Snap[] }).__screenshotRestoreSnaps__ = snaps;
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
  }).catch(() => undefined);
}

/**
 * Undo {@link flattenScrollersForCapture}. Must run after every capture
 * round regardless of capture failures, or body/html stay mutated and
 * break interactive scroll in --annotate mode.
 */
async function restoreScrollersAfterCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const snaps = (window as Window & { __screenshotRestoreSnaps__?: Array<{ el: Element; style: string }> }).__screenshotRestoreSnaps__;
    if (!snaps) return;
    for (const { el, style } of snaps) {
      try {
        if (style) el.setAttribute('style', style);
        else el.removeAttribute('style');
      } catch {
        // Element may have been detached; skip.
      }
    }
    delete (window as Window & { __screenshotRestoreSnaps__?: Array<{ el: Element; style: string }> }).__screenshotRestoreSnaps__;
  }).catch(() => undefined);
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

    // Fallback to page screenshot; see flattenScrollersForCapture for why
    // inner scrollers are flattened first. Result: a single PNG that
    // contains the entire scrollable area even when the app uses a
    // `100vh` shell with inner scrollers.
    await flattenScrollersForCapture(page);
    try {
      await page.screenshot({ path: outputPath, fullPage: true }).catch(() => undefined);
    } finally {
      await restoreScrollersAfterCapture(page);
    }

    return outputPath;
  } catch {
    return null;
  }
}

export interface SectionScreenshotOptions {
  /** Max sections to capture; guards against pathological page heights. Default 12. */
  maxSections?: number;
  /** Height of each section in px. Defaults to the current viewport height. */
  sectionHeight?: number;
}

/**
 * Capture the entire scrollable page as a series of viewport-sized sections.
 *
 * A single flattened full-page PNG of a tall app page downscales to
 * illegibility when inspected, so this instead captures
 * `section-0.png … section-N.png` — each one viewport-height slice of the
 * flattened document at native scale, top to bottom. Uses the same
 * flatten/restore round-trip as {@link takeScreenshot}.
 *
 * @param page - Playwright page
 * @param outputDir - Directory the section PNGs are written into
 * @param baseName - File name prefix (default `section`)
 * @returns Paths of the captured sections, top first
 */
export async function takeScreenshotSections(
  page: Page,
  outputDir: string,
  baseName = 'section',
  options: SectionScreenshotOptions = {},
): Promise<string[]> {
  const paths: string[] = [];
  try {
    mkdirSync(outputDir, { recursive: true });
    await flattenScrollersForCapture(page);
    try {
      const dims = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      })).catch(() => null);
      if (dims && dims.height > 0 && dims.viewportWidth > 0) {
        const sectionHeight = options.sectionHeight && options.sectionHeight > 0
          ? options.sectionHeight
          : dims.viewportHeight;
        const maxSections = options.maxSections ?? 12;
        const count = Math.min(Math.ceil(dims.height / sectionHeight), maxSections);
        const width = Math.max(1, Math.min(dims.width, dims.viewportWidth));
        for (let i = 0; i < count; i++) {
          const y = i * sectionHeight;
          const height = Math.min(sectionHeight, dims.height - y);
          if (height <= 0) break;
          const outPath = join(outputDir, `${baseName}-${i}.png`);
          await page.screenshot({
            path: outPath,
            fullPage: true,
            clip: { x: 0, y, width, height },
          }).catch(() => undefined);
          paths.push(outPath);
        }
      }
    } finally {
      await restoreScrollersAfterCapture(page);
    }
    return paths;
  } catch {
    return paths;
  }
}

/** Sanitize a name for use as a filename */
export function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}
