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
 * trigger fills the matching fields after the affordance click so the
 * frame's screenshot captures a populated form. The trigger does NOT
 * click submit — interaction tests verify "the modal opens with the
 * right pattern at the right slot"; form submission and the resulting
 * `persist` cascade belong to the data-mutation observer's separate
 * frame, fired via the persistor trait directly.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import type { ExtendedWalkStep } from '../../planner/types.js';
import { fillFormFieldsFromMap } from '../../browser/interaction.js';

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
    const isCrudFlow =
      step.testKind === 'crud-create' ||
      step.testKind === 'crud-edit' ||
      step.testKind === 'crud-delete';

    // For crud-edit / crud-delete, prefer a row-scoped selector — the
    // affordance lives on a per-row itemAction button stamped with
    // `data-row-id`. When `targetRowId` is undefined, fall back to the
    // first row's button (deterministic structural position, not a
    // heuristic).
    const baseSelector = `[data-testid="action-${step.event}"]`;
    const selector = (isCrudFlow && step.targetRowId !== undefined)
      ? `${baseSelector}[data-row-id="${step.targetRowId}"]`
      : (isCrudFlow && (step.testKind === 'crud-edit' || step.testKind === 'crud-delete'))
        ? `${baseSelector}[data-row-id]`
        : baseSelector;

    const locator = page.locator(selector).first();
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

    // Form data present → wait for the form to mount, fill it.
    if (step.formData !== undefined && Object.keys(step.formData).length > 0) {
      await page.waitForTimeout(formMountTimeoutMs);
      await fillFormFieldsFromMap(page, formContainerSelector, step.formData);
    }

    // Crud-flow steps: also click the submit/confirm affordance to
    // drive the persist round-trip. Interaction tests stop at form
    // fill; CRUD tests run the full chain so the observer can verify
    // emit + entity diff + DOM list update on one frame.
    if (isCrudFlow) {
      const followUpEvent = step.submitEvent ?? step.confirmEvent;
      if (followUpEvent !== undefined) {
        await page.waitForTimeout(formMountTimeoutMs);
        const followUpLocator = page.locator(`[data-testid="action-${followUpEvent}"]`).first();
        try {
          const visible = await followUpLocator.isVisible({ timeout: 500 });
          if (visible) {
            await followUpLocator.click({ timeout: clickTimeoutMs });
          }
        } catch {
          // Submit/confirm not found — observer will fail with a
          // diagnostic detail. Don't bail; let the rest of the tick
          // settle so the snapshot captures the partial state.
        }
        // Wait long enough for the persist cascade to land before
        // the kernel takes its post-tick snapshot. The chain on a
        // CRUD step is multi-hop:
        //   submit click → modal SAVE emit → persistor DO_X →
        //   server persist → server emits ITEM_X → bus delivers to
        //   browse trait → browse INIT → server fetch → state update.
        // The default 800ms settle covers single-event cascades but
        // multi-hop chains routinely run 1.2-1.5s. Without this
        // explicit wait, `frame.entityChanges` and DOM count read
        // pre-cascade state and the diff/dom axes report ✗ even
        // when the persist actually succeeded. 1500ms is an upper
        // bound observed for std-list / std-cart / std-agent-builder
        // on a warm server.
        await page.waitForTimeout(1500);
      }
      return true;
    }

    if (step.formData === undefined || Object.keys(step.formData).length === 0) {
      return true;
    }
    // Interaction-test path: form was filled, no submit click.
    return true;
  };
}
