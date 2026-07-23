/**
 * Interactive "play mode" session.
 *
 * After a verification walk finishes, keeps the headed browser open for
 * free-form human interaction. Injects a small floating badge with a
 * Done button and waits indefinitely until it is clicked or the
 * page/browser closes.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import { OVERLAY_CSS } from './annotator.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface InteractiveSessionOptions {
  /** Heading shown in the badge, e.g. the item name. */
  title?: string;
  /** Extra line of context, e.g. "walk passed 6/10". */
  subtitle?: string;
}

// ── CSS ────────────────────────────────────────────────────────────────

const SESSION_CSS = `
  #orbital-session-badge {
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 99999;
    background: #ffffff;
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0, 0, 0, 0.08);
    width: 300px;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  #orbital-session-badge .oa-header { padding: 14px 18px 10px; border-bottom: none; }
  #orbital-session-badge .oa-footer { padding: 10px 18px 14px; border-top: none; justify-content: flex-end; }
`;

// ── Session ────────────────────────────────────────────────────────────

/**
 * Keep the browser open for free interaction until the human clicks Done
 * or the page/browser closes. Never throws on detach.
 */
export async function runInteractiveSession(
  page: Page,
  opts: InteractiveSessionOptions = {},
): Promise<void> {
  if (page.isClosed()) return;

  try {
    await page.evaluate(
      ({ css, html }: { css: string; html: string }) => {
        const style = document.createElement('style');
        style.id = 'orbital-session-style';
        style.textContent = css;
        document.head.appendChild(style);

        const container = document.createElement('div');
        container.id = 'orbital-session-container';
        container.innerHTML = html;
        document.body.appendChild(container);

        type SessionWindow = Window & { __isDone?: () => void; __isResult?: boolean };
        (window as SessionWindow).__isDone = () => {
          (window as SessionWindow).__isResult = true;
        };
      },
      {
        css: OVERLAY_CSS + SESSION_CSS,
        html: `
          <div id="orbital-session-badge">
            <div class="oa-header">
              <h2>${opts.title ?? 'Interactive session'}</h2>
              <div class="oa-context">
                ${opts.subtitle ? `${opts.subtitle}<br/>` : ''}
                Walk complete — the page is live. Interact freely, then click Done.
              </div>
            </div>
            <div class="oa-footer">
              <button class="oa-submit" onclick="window.__isDone()">Done</button>
            </div>
          </div>
        `,
      },
    );
  } catch {
    return; // page closed between guard and injection
  }

  try {
    await page.waitForFunction(
      () => (window as Window & { __isResult?: boolean }).__isResult,
      null,
      { timeout: 0 },
    );
  } catch {
    // page/browser closed while waiting — treat as Done
  }

  try {
    await page.evaluate(() => {
      document.getElementById('orbital-session-container')?.remove();
      document.getElementById('orbital-session-style')?.remove();
      type SessionWindow = Window & { __isDone?: () => void; __isResult?: boolean };
      delete (window as SessionWindow).__isDone;
      delete (window as SessionWindow).__isResult;
    });
  } catch {
    // page already closed — nothing to clean
  }
}
