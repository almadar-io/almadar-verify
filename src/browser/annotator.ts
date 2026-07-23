/**
 * Shared annotation overlay for visual quality review.
 *
 * Injects a modal overlay into a Playwright page, waits for user
 * verdict (pass/fail/skip), and appends results to a JSONL file.
 * Used by both orbital-verify and runtime-verify.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────

export type AnnotationVerdict = 'pass' | 'fail' | 'skip';

export type AnnotationCategory =
  | 'no-styling'
  | 'empty-content'
  | 'broken-layout'
  | 'missing-ui'
  | 'compile-error'
  | 'runtime-error'
  | 'other';

export interface Annotation {
  behavior: string;
  trait: string;
  state: string;
  event: string;
  slot: string;
  pattern: string;
  verdict: AnnotationVerdict;
  categories?: AnnotationCategory[];
  notes?: string;
  screenshotPath: string;
  timestamp: string;
}

export interface AnnotationPromptOptions {
  trait: string;
  state: string;
  event: string;
  slot: string;
  pattern: string;
  screenshotPath: string;
}

// ── CSS ────────────────────────────────────────────────────────────────

export const OVERLAY_CSS = `
  #orbital-annotate-modal {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 99999;
    background: #ffffff;
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0, 0, 0, 0.08);
    width: 380px;
    max-height: 90vh;
    overflow-y: auto;
    padding: 0;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    cursor: default;
  }
  .oa-header {
    padding: 20px 24px 16px;
    border-bottom: 1px solid #e5e7eb;
    cursor: grab;
    user-select: none;
  }
  .oa-header:active { cursor: grabbing; }
  .oa-header h2 { margin: 0 0 4px; font-size: 16px; font-weight: 600; color: #111827; }
  .oa-header .oa-context { font-size: 13px; color: #6b7280; line-height: 1.4; }
  .oa-body { padding: 20px 24px; }
  .oa-section { margin-bottom: 20px; }
  .oa-section:last-child { margin-bottom: 0; }
  .oa-label { display: block; font-size: 13px; font-weight: 500; color: #374151; margin-bottom: 8px; }
  .oa-verdict-group { display: flex; gap: 8px; }
  .oa-verdict-btn {
    flex: 1; padding: 10px 16px; border: 2px solid #e5e7eb; border-radius: 8px;
    background: #ffffff; font-size: 14px; font-weight: 500; cursor: pointer;
    transition: all 0.15s ease; color: #374151;
  }
  .oa-verdict-btn:hover { border-color: #9ca3af; }
  .oa-verdict-btn[data-selected="true"][data-verdict="pass"] { background: #ecfdf5; border-color: #10b981; color: #059669; }
  .oa-verdict-btn[data-selected="true"][data-verdict="fail"] { background: #fef2f2; border-color: #ef4444; color: #dc2626; }
  .oa-verdict-btn[data-selected="true"][data-verdict="skip"] { background: #f3f4f6; border-color: #6b7280; color: #4b5563; }
  .oa-categories { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .oa-categories label {
    display: flex; align-items: center; gap: 8px; padding: 8px 10px;
    border-radius: 6px; font-size: 13px; color: #374151; cursor: pointer;
    border: 1px solid transparent; transition: all 0.15s ease;
  }
  .oa-categories label:hover { background: #f9fafb; }
  .oa-categories input[type="checkbox"] { width: 16px; height: 16px; accent-color: #ef4444; }
  .oa-categories input[type="checkbox"]:checked + span { color: #dc2626; font-weight: 500; }
  .oa-categories-hidden { display: none; }
  .oa-notes {
    width: 100%; min-height: 72px; padding: 10px 12px; border: 1px solid #d1d5db;
    border-radius: 8px; font-size: 13px; font-family: inherit; resize: vertical;
    color: #111827; box-sizing: border-box;
  }
  .oa-notes:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15); }
  .oa-footer { padding: 16px 24px; border-top: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; }
  .oa-counter { font-size: 12px; color: #9ca3af; }
  .oa-submit {
    padding: 10px 24px; background: #4f46e5; color: #ffffff; border: none;
    border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer;
    transition: background 0.15s ease;
  }
  .oa-submit:hover { background: #4338ca; }
  .oa-submit:disabled { background: #9ca3af; cursor: not-allowed; }
`;

// ── HTML Builder ───────────────────────────────────────────────────────

function buildOverlayHTML(opts: {
  count: number;
  trait: string;
  state: string;
  event: string;
  slot: string;
  pattern: string;
}): string {
  return `
    <div id="orbital-annotate-modal">
      <div class="oa-header" id="oa-drag-handle">
        <h2>Annotate #${opts.count}</h2>
        <div class="oa-context">
          <strong>${opts.trait}</strong> ${opts.event} &rarr; ${opts.state}<br/>
          Pattern: <code>${opts.pattern}</code> in <code>${opts.slot}</code>
        </div>
      </div>
      <div class="oa-body">
        <div class="oa-section">
          <span class="oa-label">Verdict</span>
          <div class="oa-verdict-group">
            <button class="oa-verdict-btn" data-verdict="pass" onclick="window.__oaSelectVerdict('pass')">Pass</button>
            <button class="oa-verdict-btn" data-verdict="fail" onclick="window.__oaSelectVerdict('fail')">Fail</button>
            <button class="oa-verdict-btn" data-verdict="skip" onclick="window.__oaSelectVerdict('skip')">Skip</button>
          </div>
        </div>
        <div class="oa-section oa-categories-hidden" id="oa-categories-section">
          <span class="oa-label">Issue Categories</span>
          <div class="oa-categories">
            <label><input type="checkbox" name="oa-cat" value="no-styling"><span>No styling</span></label>
            <label><input type="checkbox" name="oa-cat" value="empty-content"><span>Empty content</span></label>
            <label><input type="checkbox" name="oa-cat" value="broken-layout"><span>Broken layout</span></label>
            <label><input type="checkbox" name="oa-cat" value="missing-ui"><span>Missing UI</span></label>
            <label><input type="checkbox" name="oa-cat" value="compile-error"><span>Compile error</span></label>
            <label><input type="checkbox" name="oa-cat" value="runtime-error"><span>Runtime error</span></label>
            <label><input type="checkbox" name="oa-cat" value="other"><span>Other</span></label>
          </div>
        </div>
        <div class="oa-section">
          <span class="oa-label">Notes (optional)</span>
          <textarea class="oa-notes" id="oa-notes" placeholder="What did you notice?"></textarea>
        </div>
      </div>
      <div class="oa-footer">
        <span class="oa-counter">#${opts.count}</span>
        <button class="oa-submit" id="oa-submit" disabled onclick="window.__oaSubmit()">Submit</button>
      </div>
    </div>
  `;
}

// ── Annotator Class ────────────────────────────────────────────────────

/**
 * Manages annotation via Playwright page overlay.
 * Injects a styled modal into the browser page for each review point.
 * Waits indefinitely for user verdict, then appends to JSONL.
 */
export class Annotator {
  private outputPath: string;
  private behavior: string;
  private count = 0;

  constructor(outputPath: string, behavior: string) {
    this.outputPath = outputPath;
    this.behavior = behavior;

    const dir = dirname(outputPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Show annotation overlay and wait for user input.
   * Returns the annotation (also appended to JSONL), or null if skipped.
   */
  async prompt(page: Page, opts: AnnotationPromptOptions): Promise<Annotation | null> {
    this.count++;

    const overlayHTML = buildOverlayHTML({
      count: this.count,
      trait: opts.trait,
      state: opts.state,
      event: opts.event,
      slot: opts.slot,
      pattern: opts.pattern,
    });

    // Inject overlay + interaction handlers
    await page.evaluate(
      ({ css, html }: { css: string; html: string }) => {
        const style = document.createElement('style');
        style.id = 'orbital-annotate-style';
        style.textContent = css;
        document.head.appendChild(style);

        const container = document.createElement('div');
        container.id = 'orbital-annotate-container';
        container.innerHTML = html;
        document.body.appendChild(container);

        let selectedVerdict: string | null = null;

        type AnnotatorWindow = Window & {
          __oaSelectVerdict?: (verdict: string) => void;
          __oaSubmit?: () => void;
          __oaResult?: { verdict: string | null; categories: string[]; notes: string };
        };
        (window as AnnotatorWindow).__oaSelectVerdict = (verdict: string) => {
          selectedVerdict = verdict;
          document.querySelectorAll('.oa-verdict-btn').forEach((btn) => {
            (btn as HTMLElement).dataset.selected = String(
              (btn as HTMLElement).dataset.verdict === verdict,
            );
          });
          const catSection = document.getElementById('oa-categories-section');
          if (catSection) {
            catSection.className = verdict === 'fail' ? 'oa-section' : 'oa-section oa-categories-hidden';
          }
          const submitBtn = document.getElementById('oa-submit') as HTMLButtonElement;
          if (submitBtn) submitBtn.disabled = false;
        };

        (window as AnnotatorWindow).__oaSubmit = () => {
          const categories: string[] = [];
          document.querySelectorAll('input[name="oa-cat"]:checked').forEach((cb) => {
            categories.push((cb as HTMLInputElement).value);
          });
          const notes = (document.getElementById('oa-notes') as HTMLTextAreaElement)?.value || '';
          (window as AnnotatorWindow).__oaResult = {
            verdict: selectedVerdict,
            categories,
            notes,
          };
        };

        // Drag logic
        const modal = document.getElementById('orbital-annotate-modal');
        const handle = document.getElementById('oa-drag-handle');
        if (modal && handle) {
          let isDragging = false;
          let offsetX = 0;
          let offsetY = 0;
          handle.addEventListener('mousedown', (e) => {
            if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
            isDragging = true;
            const rect = modal.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            e.preventDefault();
          });
          document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            modal.style.left = (e.clientX - offsetX) + 'px';
            modal.style.top = (e.clientY - offsetY) + 'px';
            modal.style.right = 'auto';
          });
          document.addEventListener('mouseup', () => { isDragging = false; });
        }
      },
      { css: OVERLAY_CSS, html: overlayHTML },
    );

    // Wait forever for user to click Submit
    const result = await page.waitForFunction(
      () => (window as Window & { __oaResult?: { verdict: string | null; categories: string[]; notes: string } }).__oaResult,
      null,
      { timeout: 0 },
    );

    const data = await result.jsonValue() as {
      verdict: string;
      categories: string[];
      notes: string;
    };

    // Clean up DOM + globals
    await page.evaluate(() => {
      document.getElementById('orbital-annotate-container')?.remove();
      document.getElementById('orbital-annotate-style')?.remove();
      type AnnotatorWindow = Window & {
        __oaSelectVerdict?: (verdict: string) => void;
        __oaSubmit?: () => void;
        __oaResult?: { verdict: string | null; categories: string[]; notes: string };
      };
      delete (window as AnnotatorWindow).__oaSelectVerdict;
      delete (window as AnnotatorWindow).__oaSubmit;
      delete (window as AnnotatorWindow).__oaResult;
    });

    if (data.verdict === 'skip') return null;

    const annotation: Annotation = {
      behavior: this.behavior,
      trait: opts.trait,
      state: opts.state,
      event: opts.event,
      slot: opts.slot,
      pattern: opts.pattern,
      verdict: data.verdict as AnnotationVerdict,
      categories: data.verdict === 'fail' && data.categories.length > 0
        ? data.categories as AnnotationCategory[]
        : undefined,
      notes: data.notes || undefined,
      screenshotPath: opts.screenshotPath,
      timestamp: new Date().toISOString(),
    };

    appendFileSync(this.outputPath, JSON.stringify(annotation) + '\n', 'utf-8');
    return annotation;
  }

  getCount(): number {
    return this.count;
  }
}
