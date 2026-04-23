/**
 * Click-path sample (VG3).
 *
 * Pass 1 of the state walk fires every transition via
 * `window.__orbitalVerification.sendEvent`, which bypasses the UI
 * entirely. 100% transition-graph coverage via that path says nothing
 * about whether the button the schema promises actually wires to the
 * event — you can ship a broken button and still see PASS.
 *
 * VG3 closes that gap with a **sample**: for each trait, pick ONE of
 * its declared user-dispatchable events, find the corresponding DOM
 * trigger, click it, and assert that *some* trait's state advanced as
 * a result. Looking at "any trait changed" (not just the owning trait)
 * matters because cross-trait handoffs are legit — a cart's `ADD_ITEM`
 * button fires into a modal trait that then flips from `closed` to
 * `form`, while the cart's own state stays on `browsing`.
 *
 * One click per trait is enough to prove the click-path plumbing end-
 * to-end: button → bus emit → reducer dispatch → state update somewhere.
 * If the sample passes, the remaining events of the same trait either
 * share the plumbing or are off the user's happy path.
 *
 * This is deliberately narrower than Pass 2 "click every transition" —
 * sampling keeps the walk fast while still catching the class of
 * bugs where a button's `action` prop silently points at a dead event
 * key or the wrong selector.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import type { EventPayload } from '@almadar/core';
import { readTraitSnapshots, type TraitStateSnapshot } from '../runtime/state-bridge.js';
import { fillFormFieldsWithValues, type FilledFormValues } from './interaction.js';
import {
  probeCascadeFlowDelta,
  type CascadeFlowDeltaResult,
  type TraitListenerLike,
} from './catalog-probes.js';

/**
 * Events the runtime fires on its own (lifecycle) or that aren't user-
 * invokable by design. VG3 excludes these from click-path candidates:
 * clicking a lifecycle event would at best be a no-op and at worst
 * mask the real "button wires to X" failure the sample is meant to
 * catch.
 */
const LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
  'INIT',
  'LOAD',
  '$MOUNT',
  '$UNMOUNT',
]);

/** Input shape for one trait. Kept minimal so callers don't need the full IR. */
export interface ClickPathTraitInput {
  /** Name of the trait we're sampling on behalf of. */
  traitName: string;
  /**
   * Event keys the schema declared as user-dispatchable for this trait
   * (typically `trait.renderUIEvents` from the caller's plan). Events
   * not in this list are skipped (they're cascade / server-emit only
   * per VG2). Lifecycle events (`INIT` / `LOAD` / `$MOUNT`) are
   * filtered out internally.
   */
  userDispatchableEvents: readonly string[];
}

/**
 * One render-site entry for the per-site VG3 sample (VG14).
 *
 * A render-site is a distinct `(slot, patternType, propPath)` occurrence
 * where a declared event key appears in a trait's render-ui tree. VG3's
 * original design sampled ONE event per trait; on patterns like
 * `DataGrid` that expose BOTH a primary `action` prop AND a per-row
 * `itemActions[].event` list, only the first click got tested and the
 * itemAction buttons were never verified.
 *
 * Keying by (trait, slot, pattern, propPath, index) surfaces both the
 * page-header button and the row itemAction as separate samples, so
 * std-cart's `ADD_ITEM` (header) AND `REQUEST_REMOVE` (row) both land in
 * the VG3 report.
 */
export interface ClickPathRenderSite {
  /** Trait that owns this render-site. */
  traitName: string;
  /**
   * Stable identifier: `"<slot>:<patternType>:<propPath>[:<index>]"`.
   * Callers generate this at extraction time; sampleClickPathsPerSite
   * treats duplicate keys as already-clicked and skips them.
   */
  siteKey: string;
  /** Event key to click. Lifecycle events must not appear here. */
  event: string;
  /** Slot (`"main"`, `"modal"`, `"drawer"`, ...) for debugging output. */
  slot: string;
  /** Pattern type (`"button"`, `"data-grid"`, ...) for debugging output. */
  patternType: string;
  /**
   * Dotted path to the event-valued prop within the pattern's
   * propsSchema, e.g. `"action"` for Button, `"itemActions[].event"` for
   * DataGrid. Exposed in the report's detail line for triage.
   */
  propPath: string;
  /**
   * Optional — the transition that ORIGINALLY rendered this site. Used
   * to reach non-initial-state sites (e.g., buttons inside a modal that
   * only paints in the trait's `open` state). The sampler dispatches
   * `reach.event` into the runtime BEFORE clicking the target, giving
   * the schema a chance to render the site's host slot. Callers that
   * don't populate this fall back to "click from initial state" which
   * works for main-slot sites but loses modal-internal coverage (VG16).
   *
   * When omitted OR when `toState === fromState` (the transition is a
   * no-state-change render refresh), the sampler skips the dispatch.
   */
  reach?: {
    /** Event key that triggered the rendering transition. */
    event: string;
    /** State the trait was in before the transition. */
    fromState: string;
    /** State the trait is in after the transition (and while the site renders). */
    toState: string;
    /**
     * Optional payload for the reach dispatch. Without it the sampler
     * fires `sendEvent(reach.event, {})` — which is enough to drive a
     * no-payload transition but drops context for payload-bearing events
     * (e.g. `REQUEST_REMOVE { id }` sets `@entity.pendingId = @payload.id`
     * and the Confirm button downstream reads back `@entity.pendingId`).
     * When the caller knows the event's payload schema, supply a
     * synthesized value (typically via `buildMinimalPayload`) so the
     * downstream state has real data to render + assert against. Types
     * through `EventPayload` from `@almadar/core` so it can't drift from
     * the contract every other emit/listen site uses.
     */
    payload?: EventPayload;
  };
}

/** Result of one trait's click-path sample. */
export interface ClickPathSampleCheck {
  traitName: string;
  /** Event we tried to click. `null` when there was no candidate to try. */
  event: string | null;
  /** CSS selector that matched + was clicked. `null` when no selector matched. */
  selector: string | null;
  /**
   * Snapshot of every trait's state BEFORE the click, keyed by
   * trait name. Used as the baseline for the "did anything change"
   * assertion.
   */
  statesBefore: Record<string, string>;
  /** Same shape, AFTER the click + settle. */
  statesAfter: Record<string, string>;
  /**
   * Trait names whose state differed between before and after.
   * A non-empty array means the click made something happen; an empty
   * array with `selector !== null` means we clicked a button and
   * nothing happened (likely broken wiring or stale button).
   */
  changedTraits: string[];
  passed: boolean;
  detail: string;
  /**
   * VG11d — cascade-flow delta. When the caller supplies
   * `listenerTraits` in {@link ClickPathOptions}, each listener whose
   * `listens[].event === site.event` AND whose triggered transition
   * has persist/fetch effects contributes an entry here. One entry per
   * `(listener trait, triggered event)` pair; `passed` is true when every
   * mutation on the triggered transition landed the expected row delta.
   * Empty array when no cascade was declared for the clicked event.
   */
  cascadeFlowDeltas?: CascadeFlowDeltaResult[];
  /**
   * VG11e — submitted-entity DOM verification. For form-submit sites,
   * `fillFormFieldsWithValues` records the faker-generated value for
   * each field (`name → value`). After the cascade delta confirms +1
   * row, each value is searched in the page DOM; `submittedValues` and
   * `submittedVisibility` record what was submitted and which values
   * appeared. Only populated when the site was a form-submit AND a
   * cascade flow delta ran.
   */
  submittedValues?: FilledFormValues;
  submittedVisibility?: Array<{ name: string; value: string; visible: boolean }>;
}

export interface ClickPathOptions {
  /**
   * Page reset hook — called before sampling so the click runs against
   * a freshly navigated page. If omitted, the probe uses whatever page
   * state the caller left behind; callers that drove the page past
   * initial via pass-1 should provide a reset.
   */
  reset?: (page: Page) => Promise<void>;
  /**
   * Wait (ms) after clicking before re-reading state. Mirrors the
   * engine's default settle window. Default: 1500.
   */
  settleMs?: number;
  /**
   * Max time (ms) to wait after reset for the trait snapshot bridge to
   * populate. The runtime needs a tick to wire `registerTraitSnapshot`
   * for each trait before any read succeeds. Default: 5000.
   */
  stateReadyTimeoutMs?: number;
  /** Poll interval (ms) while waiting for the bridge. Default: 150. */
  stateReadyPollMs?: number;
  /**
   * VG11d — listener trait catalog. When supplied, each click also
   * triggers a cascade-flow delta assertion: any listener whose
   * `listens[].event` matches the clicked event AND whose triggered
   * transition has persist/fetch effects must produce the expected
   * row-count delta within {@link cascadeFlowPollMs}. Closes the
   * blind-spot where VG11b skips cascade-triggered frames because
   * engine-synthesized payloads are unreliable — a user click carries
   * the real payload, so end-to-end delta IS testable.
   */
  listenerTraits?: readonly TraitListenerLike[];
  /** VG11d — polling timeout for cascade-flow delta. Default: 4000ms. */
  cascadeFlowPollMs?: number;
}

/**
 * Selectors for finding a clickable DOM trigger for an event. Mirrors
 * the button-finding heuristics used by `tryTriggerContractEvent` in
 * orbital-verify-unified, in priority order:
 *
 * 1. `[data-testid="action-EVENT"]` — the canonical id @almadar/ui
 *    stamps on every `action` / `event`-bound control.
 * 2. `[data-event="EVENT"]` — fallback id some older patterns emit.
 * 3. `button[type="submit"]` inside a form whose `data-submit-event`
 *    matches — catches form submits.
 */
function selectorsFor(event: string): string[] {
  return [
    `[data-testid="action-${event}"]`,
    `[data-event="${event}"]`,
    `form[data-submit-event="${event}"] button[type="submit"]`,
  ];
}

async function tryClickSelector(
  page: Page,
  selector: string,
  timeoutMs = 500,
): Promise<boolean> {
  try {
    const locator = page.locator(selector).first();
    if (!(await locator.isVisible({ timeout: timeoutMs }).catch(() => false))) {
      return false;
    }
    await locator.click({ timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

/** Turn `readTraitSnapshots` output into a `{ traitName: currentState }` map. */
function snapshotsToStateMap(snapshots: TraitStateSnapshot[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of snapshots) out[s.traitName] = s.currentState;
  return out;
}

function diffStateMaps(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const changed: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (before[k] !== after[k]) changed.push(k);
  }
  return changed;
}

/**
 * Execute one click-path sample against a running page. Returns a
 * {@link ClickPathSampleCheck} with the outcome for the verifier's
 * report.
 *
 * Strategy:
 * 1. Reset the page (caller hook) and wait for the snapshot bridge
 *    to populate.
 * 2. For each user-dispatchable event (lifecycle excluded), find a
 *    clickable trigger in the DOM.
 * 3. Snapshot every trait's state, click, wait, snapshot again.
 * 4. Diff: if any trait's state changed, the click fired and wired
 *    through; PASS. Otherwise the click hit a dead button; FAIL.
 * 5. If no selector matched any candidate event, the sample is FAIL
 *    with a "no trigger" detail — the schema claims a user-dispatchable
 *    event but the DOM doesn't expose it.
 */
export async function sampleClickPath(
  page: Page,
  trait: ClickPathTraitInput,
  options: ClickPathOptions = {},
): Promise<ClickPathSampleCheck> {
  const settleMs = options.settleMs ?? 1500;
  const stateReadyTimeoutMs = options.stateReadyTimeoutMs ?? 5000;
  const stateReadyPollMs = options.stateReadyPollMs ?? 150;

  if (options.reset) {
    await options.reset(page);
  }

  // Wait for at least one snapshot to populate — the bridge needs a
  // tick after page load before `getTraitSnapshots()` reports anything.
  let statesBefore: Record<string, string> = {};
  const deadline = Date.now() + stateReadyTimeoutMs;
  while (Date.now() < deadline) {
    const snaps = await readTraitSnapshots(page);
    if (snaps.length > 0) {
      statesBefore = snapshotsToStateMap(snaps);
      break;
    }
    await page.waitForTimeout(stateReadyPollMs);
  }

  const candidates = trait.userDispatchableEvents.filter((e) => !LIFECYCLE_EVENTS.has(e));

  if (candidates.length === 0) {
    return {
      traitName: trait.traitName,
      event: null,
      selector: null,
      statesBefore,
      statesAfter: statesBefore,
      changedTraits: [],
      passed: true,
      detail:
        `skipped: no non-lifecycle user-dispatchable events declared for trait ${trait.traitName}`,
    };
  }

  let firstTriedEvent: string | null = null;
  for (const event of candidates) {
    firstTriedEvent ??= event;
    for (const selector of selectorsFor(event)) {
      const clicked = await tryClickSelector(page, selector);
      if (!clicked) continue;

      await page.waitForTimeout(settleMs);
      const statesAfter = snapshotsToStateMap(await readTraitSnapshots(page));
      const changedTraits = diffStateMaps(statesBefore, statesAfter);

      return {
        traitName: trait.traitName,
        event,
        selector,
        statesBefore,
        statesAfter,
        changedTraits,
        passed: changedTraits.length > 0,
        detail: changedTraits.length > 0
          ? `clicked ${selector} → ${changedTraits.length} trait(s) changed: ` +
            changedTraits.map((t) => `${t} ${statesBefore[t] ?? 'null'} → ${statesAfter[t]}`).join(', ')
          : `clicked ${selector} but no trait state advanced — button likely wired to a dead event key`,
      };
    }
  }

  return {
    traitName: trait.traitName,
    event: firstTriedEvent,
    selector: null,
    statesBefore,
    statesAfter: statesBefore,
    changedTraits: [],
    passed: false,
    detail:
      `no clickable trigger found for any user-dispatchable event on trait ${trait.traitName}` +
      ` (tried events: [${candidates.join(', ')}])`,
  };
}

/**
 * Per-render-site click-path sample (VG14).
 *
 * Replaces `sampleClickPath`'s one-click-per-trait heuristic with one
 * click per distinct render-site, so patterns that expose multiple
 * event-valued props (DataGrid's primary `action` AND per-row
 * `itemActions[].event`, for instance) all get exercised. Dedupes by
 * `site.siteKey` — same site keyed by caller won't be clicked twice
 * even if two callers pass it in.
 *
 * Each site is sampled in isolation: we reset the page via
 * `options.reset`, wait for the snapshot bridge, snapshot state, click,
 * wait, snapshot again, and diff. Same pass/fail rule as the per-trait
 * sample: any trait's state must advance as a result of the click.
 *
 * Lifecycle events (`INIT` / `LOAD` / `$MOUNT` / `$UNMOUNT`) are dropped
 * at the input boundary — callers typically exclude them during
 * render-site extraction, but the filter is defensive.
 */
export async function sampleClickPathsPerSite(
  page: Page,
  sites: readonly ClickPathRenderSite[],
  options: ClickPathOptions = {},
): Promise<ClickPathSampleCheck[]> {
  const results: ClickPathSampleCheck[] = [];
  const seen = new Set<string>();

  for (const site of sites) {
    if (seen.has(site.siteKey)) continue;
    seen.add(site.siteKey);
    if (LIFECYCLE_EVENTS.has(site.event)) continue;

    // Reset the page per site so clicks don't leak state across samples.
    // Without this, click #2 runs from whatever state click #1 left — the
    // sample loses the clean "did THIS click make something happen"
    // signal that's the whole point of VG3.
    const result = await sampleOneSite(page, site, options);
    results.push(result);
  }

  return results;
}

/**
 * Helper: run a single click-path sample against one render-site. Shares
 * the reset + bridge-wait + diff logic with `sampleClickPath` but keyed
 * on a specific event (not a list of candidates).
 */
async function sampleOneSite(
  page: Page,
  site: ClickPathRenderSite,
  options: ClickPathOptions,
): Promise<ClickPathSampleCheck> {
  const settleMs = options.settleMs ?? 1500;
  const stateReadyTimeoutMs = options.stateReadyTimeoutMs ?? 5000;
  const stateReadyPollMs = options.stateReadyPollMs ?? 150;

  if (options.reset) {
    await options.reset(page);
  }

  // Wait for the state-snapshot bridge to populate — every trait has
  // registered its getter and reported at least its initial state.
  const deadline = Date.now() + stateReadyTimeoutMs;
  while (Date.now() < deadline) {
    const snaps = await readTraitSnapshots(page);
    if (snaps.length > 0) break;
    await page.waitForTimeout(stateReadyPollMs);
  }

  // VG16 reach: drive the trait to `reach.toState` by CLICKING the real
  // DOM button for `reach.event` — same user flow that mounts the
  // site's host slot in production. Critically NOT `sendEvent(reach,
  // {})`: a synthesized reach payload doesn't carry row context, so
  // downstream state (lastPayload.id, entity rows, etc.) that the
  // site's click reads back would be empty. A real click on a
  // DataGrid's itemAction button carries `{id: row.id, row}` because
  // the component stamps it; a header button click carries whatever
  // its `actionPayload` resolved to. Either way, the verifier exercises
  // exactly what the user does.
  //
  // Poll for natural progression first: auto-progressing traits may
  // have already left `fromState` (e.g. CartItemLoaded lifecycle), in
  // which case there's nothing to click — the site is already reachable.
  if (site.reach && site.reach.fromState !== site.reach.toState) {
    const settleDeadline = Date.now() + 2000;
    let currentState = snapshotsToStateMap(await readTraitSnapshots(page))[site.traitName];
    while (currentState === site.reach.fromState && Date.now() < settleDeadline) {
      await page.waitForTimeout(150);
      currentState = snapshotsToStateMap(await readTraitSnapshots(page))[site.traitName];
    }
    if (currentState === site.reach.fromState) {
      let reachClicked = false;
      for (const selector of selectorsFor(site.reach.event)) {
        if (await tryClickSelector(page, selector)) {
          reachClicked = true;
          break;
        }
      }
      if (!reachClicked) {
        // Site's reach button isn't in the DOM — can't reach. Bail out
        // with a clear failure rather than masking with sendEvent
        // synthesis; this is the class of bug VG3/VG11d is meant to
        // surface.
        return {
          traitName: site.traitName,
          event: site.event,
          selector: null,
          statesBefore: snapshotsToStateMap(await readTraitSnapshots(page)),
          statesAfter: {},
          changedTraits: [],
          passed: false,
          detail:
            `reach failed for site ${site.siteKey}: no DOM button for reach event "${site.reach.event}" ` +
            `(expected selectors: ${selectorsFor(site.reach.event).join(' | ')})`,
        };
      }
      // Poll for the trait to reach toState before giving up — the
      // event pipeline is async (enqueueAndDrain runs the transition
      // + effects in a promise chain) and the render-ui slot needs
      // one React commit to mount.
      const mountDeadline = Date.now() + 2000;
      while (Date.now() < mountDeadline) {
        await page.waitForTimeout(100);
        const next = snapshotsToStateMap(await readTraitSnapshots(page))[site.traitName];
        if (next === site.reach.toState) break;
      }
    }
  }

  const snapsBefore = await readTraitSnapshots(page);
  const statesBefore = snapshotsToStateMap(snapsBefore);
  // VG11d baseline — entity row counts BEFORE the click, max'd across
  // all traits that report the entity in `data`. Matches the convention
  // used by phase4-browser's existing VG11b baseline capture.
  const countsBefore = entityCountsFromSnapshots(snapsBefore);

  // Form-submit sites (e.g. `form-section` pattern with propPath ending
  // `.submitEvent`) require filling the form before the submit click
  // produces a non-empty payload — otherwise SAVE fires with `{data: {}}`
  // and the downstream persist creates a blank row that never appears
  // in the DataGrid. Detect these sites, fill the form, and record the
  // filled values so VG11e can later assert they're visible in the DOM.
  const isFormSubmit = site.patternType === 'form-section' && /\.(submitEvent)$/.test(site.propPath);
  let submittedValues: FilledFormValues | undefined;
  if (isFormSubmit) {
    const slotContainer = `#slot-${site.slot}`;
    const result = await fillFormFieldsWithValues(page, slotContainer).catch(() => ({ count: 0, values: {} }));
    if (result.count > 0) {
      submittedValues = result.values;
    }
  }

  for (const selector of selectorsFor(site.event)) {
    const clicked = await tryClickSelector(page, selector);
    if (!clicked) continue;

    await page.waitForTimeout(settleMs);
    const statesAfter = snapshotsToStateMap(await readTraitSnapshots(page));
    const changedTraits = diffStateMaps(statesBefore, statesAfter);

    // VG11d — cascade-flow delta. Fires only when the caller supplied a
    // listener catalog; the probe stays silent when there's no cascade
    // to test. Polling lives inside the probe; reuses probeMutationDelta's
    // +1/-1/0 delta rules.
    let cascadeFlowDeltas: CascadeFlowDeltaResult[] | undefined;
    if (options.listenerTraits && options.listenerTraits.length > 0) {
      cascadeFlowDeltas = await probeCascadeFlowDelta({
        clickedEvent: site.event,
        listenerTraits: options.listenerTraits,
        baselineCounts: countsBefore,
        readAfterCounts: async () => entityCountsFromSnapshots(await readTraitSnapshots(page)),
        wait: (ms) => page.waitForTimeout(ms),
        pollTimeoutMs: options.cascadeFlowPollMs,
      });
    }

    // VG11e — submitted-entity DOM verification. If the site was a
    // form-submit AND cascade-flow delta confirmed +1 row, assert the
    // faker-generated values we filled actually appear in the page. A
    // cascade that reports +1 but never renders the new row's name /
    // description produces a silent regression the delta alone misses
    // (e.g. persist created a blank row because payload shape drift).
    let submittedVisibility: Array<{ name: string; value: string; visible: boolean }> | undefined;
    if (submittedValues && cascadeFlowDeltas && cascadeFlowDeltas.some((c) => c.passed)) {
      submittedVisibility = [];
      for (const [name, value] of Object.entries(submittedValues)) {
        // Skip very short / generic values that could false-match existing rows.
        if (typeof value !== 'string' || value.length < 4) continue;
        const visible = await page
          .locator(`text=${JSON.stringify(value)}`)
          .first()
          .isVisible({ timeout: 500 })
          .catch(() => false);
        submittedVisibility.push({ name, value, visible });
      }
    }

    const changeSummary = changedTraits.length > 0
      ? `${changedTraits.length} trait(s) changed: ` +
        changedTraits.map((t) => `${t} ${statesBefore[t] ?? 'null'} → ${statesAfter[t]}`).join(', ')
      : 'no trait state advanced';
    const cascadeSummary =
      cascadeFlowDeltas && cascadeFlowDeltas.length > 0
        ? ` | cascade: ${cascadeFlowDeltas.map((c) => (c.passed ? `${c.listeningTrait}.${c.triggeredEvent} ✓` : `${c.listeningTrait}.${c.triggeredEvent} ✗ (${c.detail})`)).join(', ')}`
        : '';
    const submittedSummary =
      submittedVisibility && submittedVisibility.length > 0
        ? ` | submitted-on-page: ${submittedVisibility.map((s) => `${s.name}=${s.visible ? '✓' : '✗'}`).join(', ')}`
        : '';
    const cascadePassed = cascadeFlowDeltas ? cascadeFlowDeltas.every((c) => c.passed) : true;
    const submittedPassed = submittedVisibility
      ? submittedVisibility.every((s) => s.visible)
      : true;
    const statePassed = changedTraits.length > 0;

    return {
      traitName: site.traitName,
      event: site.event,
      selector,
      statesBefore,
      statesAfter,
      changedTraits,
      passed: statePassed && cascadePassed && submittedPassed,
      detail: statePassed
        ? `site ${site.siteKey} clicked ${selector} → ${changeSummary}${cascadeSummary}${submittedSummary}`
        : `site ${site.siteKey} clicked ${selector} but no trait state advanced — button likely wired to a dead event key`,
      cascadeFlowDeltas,
      submittedValues,
      submittedVisibility,
    };
  }

  return {
    traitName: site.traitName,
    event: site.event,
    selector: null,
    statesBefore,
    statesAfter: statesBefore,
    changedTraits: [],
    passed: false,
    detail:
      `no clickable trigger found for site ${site.siteKey} (event: ${site.event}, slot: ${site.slot}, ` +
      `pattern: ${site.patternType}, propPath: ${site.propPath})`,
  };
}

/** Max row count per entity across every trait's `data[entity]`. */
function entityCountsFromSnapshots(snapshots: readonly TraitStateSnapshot[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of snapshots) {
    for (const [entity, rows] of Object.entries(s.data ?? {})) {
      const n = Array.isArray(rows) ? rows.length : 0;
      out.set(entity, Math.max(out.get(entity) ?? 0, n));
    }
  }
  return out;
}
