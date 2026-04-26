/**
 * `createDefaultDomTrigger` — Playwright-side helper that tries to fire
 * a step's event by clicking a real DOM affordance.
 *
 * Returns `false` if no affordance can be located; the kernel falls
 * back to `sendEvent` automatically. Returns `true` after a successful
 * click; the kernel still settles + snapshots.
 *
 * Selector cascade (first match wins):
 *  1. `[data-event-trigger="<EVENT>"]`        — explicit verifier hook
 *  2. `[data-action="<EVENT>"]`               — common Almadar UI binding
 *  3. `button[data-event-key="<EVENT>"]`      — pattern-emitted attribute
 *  4. `button[data-pattern="floating-action-button"][data-action="<EVENT>"]`
 *
 * Consumers can override the cascade by supplying their own
 * `selectors` factory. The kernel only requires the helper to honor
 * the `Driver.triggerDOM(ctx, step) → boolean` contract.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import type { ExtendedWalkStep } from '../../planner/types.js';

export interface DefaultDomTriggerOptions {
  /** Override the default selector cascade. */
  selectors?: (step: ExtendedWalkStep) => ReadonlyArray<string>;
  /** Click timeout in ms. Default: 2000. */
  clickTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;

export function createDefaultDomTrigger(
  options: DefaultDomTriggerOptions = {},
): (page: Page, step: ExtendedWalkStep) => Promise<boolean> {
  const { selectors = defaultSelectors, clickTimeoutMs = DEFAULT_TIMEOUT_MS } = options;

  return async function triggerDOM(page, step) {
    const candidates = selectors(step);
    for (const selector of candidates) {
      const locator = page.locator(selector).first();
      try {
        const visible = await locator.isVisible({ timeout: 250 });
        if (!visible) continue;
        await locator.click({ timeout: clickTimeoutMs });
        return true;
      } catch {
        continue;
      }
    }
    return false;
  };
}

function defaultSelectors(step: ExtendedWalkStep): ReadonlyArray<string> {
  const ev = step.event;
  return [
    `[data-event-trigger="${ev}"]`,
    `[data-action="${ev}"]`,
    `button[data-event-key="${ev}"]`,
    `button[data-pattern="floating-action-button"][data-action="${ev}"]`,
  ];
}
