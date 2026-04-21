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
import { readTraitSnapshots, type TraitStateSnapshot } from '../runtime/state-bridge.js';

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
