/**
 * DOM state extraction and inspection.
 *
 * Check for common error patterns in the rendered DOM:
 * "Unknown pattern", error boundaries, empty content, etc.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';

/** Vite error overlay detection result */
export interface ViteOverlayResult {
  /** Whether a vite-error-overlay element is present in the DOM */
  hasOverlay: boolean;
  /** Extracted error message text from the overlay's shadow DOM */
  errorMessage: string;
}

/**
 * Detect Vite compilation error overlay.
 *
 * Vite renders a `vite-error-overlay` custom element when there is a
 * TypeScript or build-time compilation error. The error message lives
 * inside the element's shadow DOM.
 */
export async function detectViteErrorOverlay(page: Page): Promise<ViteOverlayResult> {
  return page.evaluate(() => {
    const overlay = document.querySelector('vite-error-overlay');
    if (!overlay) {
      return { hasOverlay: false, errorMessage: '' };
    }
    const shadow = overlay.shadowRoot;
    let errorMessage = '';
    if (shadow) {
      const msgEl = shadow.querySelector('.message-body')
        ?? shadow.querySelector('pre')
        ?? shadow.querySelector('.message');
      errorMessage = (msgEl?.textContent ?? overlay.textContent ?? '').trim();
    } else {
      errorMessage = (overlay.textContent ?? '').trim();
    }
    if (errorMessage.length > 500) {
      errorMessage = errorMessage.slice(0, 500) + '...';
    }
    return { hasOverlay: true, errorMessage };
  });
}

/** DOM inspection result */
export interface DOMInspection {
  /** Unknown pattern errors found in the DOM */
  unknownPatterns: string[];
  /** Whether an error boundary fallback is visible */
  hasErrorBoundary: boolean;
  /** Whether "Objects are not valid as a React child" appears */
  hasObjectRenderError: boolean;
  /** Whether the preview area is completely empty */
  isEmpty: boolean;
  /** Whether a preview error banner is visible */
  hasPreviewError: boolean;
  /** The preview error text, if any */
  previewErrorText: string;
}

/**
 * Inspect the DOM for common rendering errors.
 *
 * @param page - Playwright page
 * @param previewSelector - CSS selector for the preview area
 */
export async function inspectDOM(
  page: Page,
  previewSelector = '[class*="livePreviewBox"], [class*="opPreviewBox"]'
): Promise<DOMInspection> {
  return page.evaluate((selector: string) => {
    const result: DOMInspection = {
      unknownPatterns: [],
      hasErrorBoundary: false,
      hasObjectRenderError: false,
      isEmpty: true,
      hasPreviewError: false,
      previewErrorText: '',
    };

    // Check for preview error banner
    const previewError = document.querySelector('[class*="previewError"]');
    if (previewError) {
      result.hasPreviewError = true;
      result.previewErrorText = (previewError.textContent ?? '').trim();
    }

    // Check preview area content
    const preview = document.querySelector(selector);
    if (!preview) return result;

    const text = (preview.textContent ?? '').trim();
    // Canvas/SVG/video/img elements have no textContent but are valid content
    const hasVisualElements = preview.querySelector('canvas, svg, video, img, iframe') !== null;
    result.isEmpty = text.length === 0 && !hasVisualElements;

    // Check for "Unknown pattern: xxx"
    const unknownMatch = text.match(/Unknown pattern:\s*\S+/g);
    if (unknownMatch) {
      result.unknownPatterns = unknownMatch;
    }

    // Check for React render error
    if (text.includes('Objects are not valid as a React child')) {
      result.hasObjectRenderError = true;
    }

    // Check for error boundary
    const errorBoundary = preview.querySelector('[class*="error-boundary"], [class*="ErrorBoundary"]');
    if (errorBoundary) {
      result.hasErrorBoundary = true;
    }

    return result;
  }, previewSelector);
}
