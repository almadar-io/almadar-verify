/**
 * `createDefaultDomTrigger` — Playwright-side helper that fires a
 * step's event by clicking a real DOM affordance, optionally filling a
 * form first.
 *
 * Returns `false` if no affordance can be located; the kernel falls
 * back to `sendEvent` automatically. Returns `true` after a successful
 * click; the kernel still settles + snapshots.
 *
 * One deterministic selector: `[data-testid="action-<EVENT>"]`. The
 * `@almadar/ui` `Button` atom stamps this attribute at source whenever
 * `action` is set, and `Form.tsx` does the same for Save / Cancel
 * buttons. If a render is missing the tag, fix the source — never add
 * a fallback strategy here.
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
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import type { ExtendedWalkStep } from '../../planner/types.js';
import {
  fillFormFieldsFromMap,
  clickSubmitAction,
} from '../../browser/interaction.js';

export interface DefaultDomTriggerOptions {
  /** Click timeout in ms. Default: 2000. */
  clickTimeoutMs?: number;
  /** How long to wait for a form to mount after the affordance click before filling. Default: 600. */
  formMountTimeoutMs?: number;
  /** Selector used to find the form container after the affordance click. Default: form-pattern + form. */
  formContainerSelector?: string;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_FORM_MOUNT_MS = 600;
const DEFAULT_FORM_SELECTOR = '[data-pattern="form-section"]';

export function createDefaultDomTrigger(
  options: DefaultDomTriggerOptions = {},
): (page: Page, step: ExtendedWalkStep) => Promise<boolean> {
  const {
    clickTimeoutMs = DEFAULT_TIMEOUT_MS,
    formMountTimeoutMs = DEFAULT_FORM_MOUNT_MS,
    formContainerSelector = DEFAULT_FORM_SELECTOR,
  } = options;

  return async function triggerDOM(page, step) {
    const locator = page.locator(`[data-testid="action-${step.event}"]`).first();
    let clicked = false;
    try {
      const visible = await locator.isVisible({ timeout: 250 });
      if (visible) {
        await locator.click({ timeout: clickTimeoutMs });
        clicked = true;
      }
    } catch {
      // Affordance not found or not clickable — kernel falls back to sendEvent.
    }

    if (!clicked) return false;

    // No form data → done after the click.
    if (step.formData === undefined || Object.keys(step.formData).length === 0) {
      return true;
    }

    // Form data present → wait for the form to mount, fill it, submit.
    await page.waitForTimeout(formMountTimeoutMs);
    await fillFormFieldsFromMap(page, formContainerSelector, step.formData);
    if (step.submitEvent === undefined) {
      // No submitEvent declared → planner found a form but no Save
      // affordance. Source bug (form-section missing `submitEvent`).
      return true;
    }
    await clickSubmitAction(page, formContainerSelector, step.submitEvent);
    return true;
  };
}
