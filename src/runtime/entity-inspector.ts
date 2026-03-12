/**
 * Entity data inspector.
 *
 * Extract entity data visibility from the DOM to verify that
 * mock data actually reached the rendered components.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';

/** Result of an entity data inspection */
export interface EntityInspection {
  /** Whether any entity data content was found in the DOM */
  hasContent: boolean;
  /** Number of entity-related DOM elements found */
  elementCount: number;
  /** Whether an "empty state" pattern is visible */
  showsEmptyState: boolean;
  /** Text content of the preview area (truncated) */
  previewText: string;
}

/**
 * Inspect the preview area for entity data content.
 * Checks for empty states, entity cards, table rows, etc.
 *
 * @param page - Playwright page
 * @param previewSelector - CSS selector for the preview area
 */
export async function inspectEntityData(
  page: Page,
  previewSelector = '[class*="livePreviewBox"], [class*="opPreviewBox"]'
): Promise<EntityInspection> {
  return page.evaluate((selector) => {
    const preview = document.querySelector(selector);
    if (!preview) {
      return { hasContent: false, elementCount: 0, showsEmptyState: false, previewText: '' };
    }

    const text = (preview.textContent ?? '').trim();

    // Count entity-related elements
    const entityElements = preview.querySelectorAll(
      '[data-pattern], [data-entity], table tbody tr, [class*="card"], [class*="Card"]'
    );

    // Check for empty state indicators
    const emptyStateTexts = ['empty', 'no data', 'no items', 'nothing to show', 'no results'];
    const showsEmptyState = emptyStateTexts.some((t) =>
      text.toLowerCase().includes(t)
    );

    return {
      hasContent: text.length > 0 && entityElements.length > 0,
      elementCount: entityElements.length,
      showsEmptyState,
      previewText: text.substring(0, 500),
    };
  }, previewSelector);
}
