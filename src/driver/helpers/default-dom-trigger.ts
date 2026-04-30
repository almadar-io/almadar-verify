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
import { createLogger } from '../../logger.js';

// Shared with the rest of the verify:dom namespace (interaction.ts,
// default-snapshot.ts) so operators see the full DOM-side timeline
// when they enable `ALMADAR_DEBUG=almadar:verify:dom`.
const domLog = createLogger('almadar:verify:dom');

export interface DefaultDomTriggerOptions {
  /** Click timeout in ms. Default: 2000. */
  clickTimeoutMs?: number;
  /** How long to wait for a form to mount after the affordance click before filling. Default: 600. */
  formMountTimeoutMs?: number;
  /** Selector used to find the form container after the affordance click. Default: form-pattern + form. */
  formContainerSelector?: string;
}

const DEFAULT_TIMEOUT_MS = 2000;
// Wait on the actual `form-section` selector (not a fixed sleep) so the
// kernel proceeds to fill as soon as the form is visible, and gives a
// realistic ceiling for animated modal mount + fetch round-trip + React
// render. Pre-fix this was a 600ms `waitForTimeout`, which raced the
// modal mount in playground runs.
const DEFAULT_FORM_MOUNT_MS = 3000;
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
    let clickError: string | undefined;
    let visibleProbe = false;
    try {
      visibleProbe = await locator.isVisible({ timeout: 250 });
      if (visibleProbe) {
        await locator.click({ timeout: clickTimeoutMs });
        clicked = true;
      }
    } catch (err) {
      clickError = err instanceof Error ? err.message : String(err);
    }
    domLog.debug('dom:fill:trigger-click', {
      step: step.coverageKey,
      selector,
      visibleProbe,
      clicked,
      ...(clickError !== undefined && { clickError }),
    });

    if (!clicked) return false;

    // Form data present → wait for the form to actually mount, then fill.
    // Pre-fix this used a fixed `waitForTimeout(formMountTimeoutMs)` (default
    // 600ms), but modal + form-section mount latency can exceed that under
    // animation / async render. The DOM dump on a missed fill showed only
    // the parent page's patterns — the modal had not yet attached when the
    // 600ms expired, so the fill walked the still-closed page and noted
    // `containerVisible: false`. Wait on the actual selector instead so
    // the verifier sees the form regardless of mount jitter.
    if (step.formData !== undefined && Object.keys(step.formData).length > 0) {
      const formAppeared = await page
        .waitForSelector(formContainerSelector, { state: 'visible', timeout: formMountTimeoutMs })
        .then(() => true)
        .catch(() => false);
      domLog.debug('dom:fill:form-mount-wait', {
        step: step.coverageKey,
        selector: formContainerSelector,
        appeared: formAppeared,
        timeoutMs: formMountTimeoutMs,
      });
      await fillFormFieldsFromMap(page, formContainerSelector, step.formData);

      const postFillDom = await page.evaluate((sel: string) => {
        const container = document.querySelector(sel);
        if (container === null) {
          // Probe ALL data-pattern attributes currently mounted so we can
          // see whether the form-section wrapper is present under a
          // different attribute or selector. This is gated on the
          // not-found path so it only fires when the verifier is
          // actually blind.
          const allPatterns = Array.from(document.querySelectorAll<HTMLElement>('[data-pattern]'))
            .map((el) => ({
              pattern: el.getAttribute('data-pattern'),
              tag: el.tagName.toLowerCase(),
              hasInputs: el.querySelectorAll('input, textarea, select').length,
              dataFieldNames: Array.from(el.querySelectorAll<HTMLElement>('[data-field-name]'))
                .map((f) => f.getAttribute('data-field-name')),
            }));
          const allInputs = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select'))
            .map((el) => ({
              name: el.name ?? '',
              tag: el.tagName.toLowerCase(),
              dataFieldName: el.getAttribute('data-field-name'),
              visible: !!(el.offsetParent || el.getClientRects().length > 0),
            }));
          return { containerFound: false, fields: [], allPatterns, allInputs };
        }
        const inputs = container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select');
        const fields: Array<{ name: string; type: string; value: string; dataFieldName: string | null }> = [];
        inputs.forEach((el) => {
          fields.push({
            name: el.name ?? '',
            type: el.tagName.toLowerCase(),
            value: String(el.value ?? ''),
            dataFieldName: el.getAttribute('data-field-name'),
          });
        });
        return { containerFound: true, fields, allPatterns: [], allInputs: [] };
      }, formContainerSelector);
      domLog.debug('dom:fill:post-fill-state', {
        step: step.coverageKey,
        testKind: step.testKind,
        expectedFormData: JSON.stringify(step.formData),
        containerFound: postFillDom.containerFound,
        domFields: JSON.stringify(postFillDom.fields),
        ...(!postFillDom.containerFound && {
          allPatterns: JSON.stringify(postFillDom.allPatterns),
          allInputs: JSON.stringify(postFillDom.allInputs),
        }),
      });
    }

    // Crud-flow steps: also click the submit/confirm affordance to
    // drive the persist round-trip. Interaction tests stop at form
    // fill; CRUD tests run the full chain so the observer can verify
    // emit + entity diff + DOM list update on one frame.
    if (isCrudFlow) {
      const followUpEvent = step.submitEvent ?? step.confirmEvent;
      if (followUpEvent !== undefined) {
        await page.waitForTimeout(formMountTimeoutMs);

        // Capture two baselines BEFORE the submit click:
        //   1. transition count — the cascade event will append to it
        //   2. entity-data signature for the targeted entity — this is
        //      the actual signal the verifier's diff axis cares about,
        //      since ListItemBrowse.data only refreshes after the
        //      cascading INIT/fetch chain completes (the success event
        //      itself fires earlier; waiting only on the event misses
        //      the data-update tail of the cascade).
        const targetEntityName = step.expectedRowDelta?.entityName ?? null;
        const baseline = await page.evaluate((entityName: string | null) => {
          const w = window as unknown as {
            __orbitalVerification?: {
              getSnapshot?: () => {
                transitions?: ReadonlyArray<unknown>;
                traits?: ReadonlyArray<{
                  data?: Record<string, ReadonlyArray<{ id?: string; updatedAt?: string }>>;
                }>;
              };
            };
          };
          const snap = w.__orbitalVerification?.getSnapshot?.();
          const txCount = snap?.transitions?.length ?? 0;
          if (entityName === null) {
            return { txCount, dataSignature: '' };
          }
          // Build signature from ANY trait that holds the entity's
          // rows; mergeEntityData later uses the same per-trait `data`
          // maps. Sort by id so order changes don't false-positive.
          const rows: Array<{ id: string; updatedAt: string }> = [];
          const seen = new Set<string>();
          for (const trait of snap?.traits ?? []) {
            const list = trait.data?.[entityName] ?? [];
            for (const r of list) {
              if (typeof r.id === 'string' && !seen.has(r.id)) {
                seen.add(r.id);
                rows.push({ id: r.id, updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '' });
              }
            }
          }
          rows.sort((a, b) => a.id.localeCompare(b.id));
          return {
            txCount,
            dataSignature: rows.map((r) => `${r.id}:${r.updatedAt}`).join('|'),
          };
        }, targetEntityName);
        domLog.debug('dom:cascade:wait-start', {
          step: step.coverageKey,
          baselineTransitionCount: baseline.txCount,
          baselineEntityRows: baseline.dataSignature.split('|').filter((s) => s.length > 0).length,
          targetEntityName,
          expectedSuccessEvent: step.expectedSuccessEvent,
        });

        const followUpLocator = page.locator(`[data-testid="action-${followUpEvent}"]`).first();
        let followUpClickResult: 'clicked' | 'not-visible' | 'errored' = 'not-visible';
        try {
          const visible = await followUpLocator.isVisible({ timeout: 500 });
          if (visible) {
            await followUpLocator.click({ timeout: clickTimeoutMs });
            followUpClickResult = 'clicked';
          }
        } catch {
          followUpClickResult = 'errored';
        }
        domLog.debug('dom:click:follow-up', {
          step: step.coverageKey,
          testKind: step.testKind,
          followUpEvent,
          result: followUpClickResult,
        });

        // Wait for the persist cascade to actually land instead of
        // guessing wall-clock time. The chain on a CRUD step is
        // multi-hop:
        //   submit click → modal SAVE emit → persistor DO_X →
        //   server persist → server emits ITEM_X → bus delivers to
        //   browse trait → browse INIT → server fetch → state update.
        //
        // The earlier 1500ms blanket wait raced this chain on slower
        // runs (1521ms observed for std-list crud-edit) and snapshot
        // read mid-cascade. Polling the snapshot's transitions array
        // for the persist's success event is a real signal: the
        // predicate exits the moment the event lands, with a generous
        // timeout cap. Falls back to the small grace-period wait if
        // expectedSuccessEvent is absent (e.g. legacy schemas missing
        // emit.success) so we don't deadlock waiting on a phantom.
        const startWaitAt = Date.now();
        const expectedEvent = step.expectedSuccessEvent ?? null;
        if (expectedEvent !== null) {
          try {
            await page.waitForFunction(
              (args: {
                baselineTx: number;
                baselineSignature: string;
                expectedEvent: string;
                targetEntity: string | null;
              }) => {
                const w = window as unknown as {
                  __orbitalVerification?: {
                    getSnapshot?: () => {
                      transitions?: ReadonlyArray<{
                        event?: string;
                        serverResponse?: { emittedEvents?: ReadonlyArray<string> };
                      }>;
                      traits?: ReadonlyArray<{
                        data?: Record<string, ReadonlyArray<{ id?: string; updatedAt?: string }>>;
                      }>;
                    };
                  };
                };
                const snap = w.__orbitalVerification?.getSnapshot?.();
                const txs = snap?.transitions ?? [];
                const slice = txs.slice(args.baselineTx);
                // Step 1: the persist's success event must have landed
                // (either as a trait's own event field — when a
                // listening trait directly handles it — or in the
                // persistor's serverResponse.emittedEvents cascade).
                const eventLanded = slice.some((t) => {
                  if (t.event === args.expectedEvent) return true;
                  const emitted = t.serverResponse?.emittedEvents ?? [];
                  return emitted.includes(args.expectedEvent);
                });
                if (!eventLanded) return false;
                // Step 2: the entity-data signature must have changed
                // from baseline. The success event fires fast (~80ms)
                // but the listening trait's INIT → fetch → Loaded
                // chain that ACTUALLY updates `traits[*].data` lands
                // a few ticks later. Without this, the predicate
                // resolves too early and the snapshot reads the
                // pre-fetch state. If no targetEntity is known, only
                // the event-landed check applies (caller's choice).
                if (args.targetEntity === null) return true;
                const rows: Array<{ id: string; updatedAt: string }> = [];
                const seen = new Set<string>();
                for (const trait of snap?.traits ?? []) {
                  const list = trait.data?.[args.targetEntity] ?? [];
                  for (const r of list) {
                    if (typeof r.id === 'string' && !seen.has(r.id)) {
                      seen.add(r.id);
                      rows.push({
                        id: r.id,
                        updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
                      });
                    }
                  }
                }
                rows.sort((a, b) => a.id.localeCompare(b.id));
                const sig = rows.map((r) => `${r.id}:${r.updatedAt}`).join('|');
                return sig !== args.baselineSignature;
              },
              {
                baselineTx: baseline.txCount,
                baselineSignature: baseline.dataSignature,
                expectedEvent,
                targetEntity: targetEntityName,
              },
              { timeout: 8000, polling: 50 },
            );
            domLog.debug('dom:cascade:wait-resolved', {
              step: step.coverageKey,
              elapsedMs: Date.now() - startWaitAt,
              expectedSuccessEvent: expectedEvent,
            });
          } catch (err) {
            domLog.warn('dom:cascade:wait-timeout', {
              step: step.coverageKey,
              elapsedMs: Date.now() - startWaitAt,
              baselineTransitionCount: baseline.txCount,
              expectedSuccessEvent: expectedEvent,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else {
          await page.waitForTimeout(1500);
          domLog.debug('dom:cascade:wait-fallback', {
            step: step.coverageKey,
            elapsedMs: Date.now() - startWaitAt,
            reason: 'no-expected-success-event',
          });
        }
        // Small grace period after the cascade event lands so the
        // listening trait's INIT/fetch/state-update can complete
        // and React can render the new data before the snapshot
        // reads it. 250ms is an empirical floor for the post-event
        // settling, NOT a wall-clock guess for the whole cascade.
        await page.waitForTimeout(250);

        const postSubmitTransitions = await page.evaluate((args: { baselineTx: number; followUpEvent: string }) => {
          const w = window as unknown as {
            __orbitalVerification?: {
              getSnapshot?: () => {
                transitions?: ReadonlyArray<{
                  event?: string;
                  traitName?: string;
                  payload?: unknown;
                  serverResponse?: { success?: boolean; emittedEvents?: ReadonlyArray<string>; error?: string };
                }>;
              };
            };
          };
          const txs = w.__orbitalVerification?.getSnapshot?.()?.transitions ?? [];
          return txs.slice(args.baselineTx).map((t) => ({
            event: t.event ?? '',
            traitName: t.traitName ?? '',
            payload: t.payload ?? null,
            serverSuccess: t.serverResponse?.success ?? null,
            serverEmits: t.serverResponse?.emittedEvents ?? [],
            serverError: t.serverResponse?.error ?? null,
          }));
        }, { baselineTx: baseline.txCount, followUpEvent });
        domLog.debug('dom:click:save-payload', {
          step: step.coverageKey,
          testKind: step.testKind,
          followUpEvent,
          postSubmitTransitionCount: postSubmitTransitions.length,
          postSubmitTransitions: JSON.stringify(postSubmitTransitions),
        });
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
