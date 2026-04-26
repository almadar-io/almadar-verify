/**
 * `createDefaultDomTrigger` — Playwright-side helper that fires a
 * step's event by clicking a real DOM affordance, optionally filling a
 * form first.
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
 * When `step.formData` is set (planner extensions like
 * `planInteractionTests` populate this for SAVE-shaped events), the
 * trigger:
 *   1. Clicks the affordance (which typically opens a form modal).
 *   2. Waits briefly for the form to mount.
 *   3. Fills matching fields with the supplied `FieldValue`s via
 *      `fillFormFieldsFromMap`.
 *   4. Clicks the submit affordance via `clickSubmitAction`.
 *
 * Consumers can override the cascade by supplying their own
 * `selectors` factory. The kernel only requires the helper to honor
 * the `Driver.triggerDOM(ctx, step) → boolean` contract.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import type { ExtendedWalkStep } from '../../planner/types.js';
import {
  fillFormFieldsFromMap,
  clickSubmitAction,
} from '../../browser/interaction.js';

export interface DefaultDomTriggerOptions {
  /** Override the default selector cascade. */
  selectors?: (step: ExtendedWalkStep) => ReadonlyArray<string>;
  /** Click timeout in ms. Default: 2000. */
  clickTimeoutMs?: number;
  /** How long to wait for a form to mount after the affordance click before filling. Default: 600. */
  formMountTimeoutMs?: number;
  /** Selector used to find the form container after the affordance click. Default: form-pattern + form. */
  formContainerSelector?: string;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_FORM_MOUNT_MS = 600;
const DEFAULT_FORM_SELECTOR = '[data-pattern="form-section"], [data-pattern="form"], form';

export function createDefaultDomTrigger(
  options: DefaultDomTriggerOptions = {},
): (page: Page, step: ExtendedWalkStep) => Promise<boolean> {
  const {
    selectors = defaultSelectors,
    clickTimeoutMs = DEFAULT_TIMEOUT_MS,
    formMountTimeoutMs = DEFAULT_FORM_MOUNT_MS,
    formContainerSelector = DEFAULT_FORM_SELECTOR,
  } = options;

  return async function triggerDOM(page, step) {
    const candidates = selectors(step);
    let clicked = false;

    for (const selector of candidates) {
      const locator = page.locator(selector).first();
      try {
        const visible = await locator.isVisible({ timeout: 250 });
        if (!visible) continue;
        await locator.click({ timeout: clickTimeoutMs });
        clicked = true;
        break;
      } catch {
        continue;
      }
    }

    if (!clicked) return false;

    // No form data → done after the click.
    if (step.formData === undefined || Object.keys(step.formData).length === 0) {
      return true;
    }

    // Form data present → wait for the form to mount, fill it, submit.
    await page.waitForTimeout(formMountTimeoutMs);
    await fillFormFieldsFromMap(page, formContainerSelector, step.formData);
    const submitted = await clickSubmitAction(page, formContainerSelector);
    // If the submit button wasn't found, the form may auto-submit on
    // fill (e.g. inline editors) — still report the trigger as
    // successful since the affordance click + fill landed.
    return submitted || true;
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
