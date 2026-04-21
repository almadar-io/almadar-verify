/**
 * Click-path sample (VG3).
 *
 * Pass 1 of the state walk fires every transition via
 * `window.__orbitalVerification.sendEvent`, which bypasses the UI
 * entirely. 100% transition-graph coverage via that path says nothing
 * about whether the button the schema promises actually wires to the
 * event — you can ship a broken button and still see PASS.
 *
 * VG3 closes that gap with a **sample**: for each trait, pick ONE
 * transition whose event is declared as user-dispatchable (schema's
 * render-ui tree has a button / action / submitEvent for it), find the
 * corresponding DOM trigger, click it, and assert the state changed.
 * One click per trait is enough to prove the click-path end-to-end:
 * button → bus emit → reducer dispatch → state update. If that sample
 * passes, the remaining transitions of the same trait either share the
 * plumbing or are off the user's happy path.
 *
 * This is deliberately narrower than Pass 2 "click every transition" —
 * sampling keeps the walk fast while still catching the class of
 * bugs where a button's `action` prop silently points at a dead event
 * key or the wrong selector.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import { getTraitCurrentState } from '../runtime/state-bridge.js';

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
  traitName: string;
  /** Initial state name — used as the expected source when no state-bridge read is available. */
  initialState: string;
  /**
   * Event keys the schema declared as user-dispatchable for this trait
   * (typically `trait.renderUIEvents` from the caller's plan). Events
   * not in this list are skipped (they're cascade / server-emit only
   * per VG2).
   */
  userDispatchableEvents: readonly string[];
  /**
   * Transition graph: used to pick a candidate whose `from` matches the
   * current state. Only the `from`, `event`, `to` fields are consulted.
   */
  transitions: ReadonlyArray<{ from: string; event: string; to: string }>;
}

/** Result of one trait's click-path sample. */
export interface ClickPathSampleCheck {
  traitName: string;
  /** Event we tried to click. `null` when no candidate satisfied the pre-conditions. */
  event: string | null;
  /** CSS selector that actually matched + was clicked. `null` on no-match. */
  selector: string | null;
  /** State the trait was in before the click, as read from the bridge. */
  stateBefore: string | null;
  /** State the trait was in after the click (and the settle wait). */
  stateAfter: string | null;
  /** True when the click fired and the state advanced to the transition's `to`. */
  passed: boolean;
  detail: string;
}

export interface ClickPathOptions {
  /**
   * Page reset hook — called before reading state so the sample
   * starts from a clean page. If omitted, the probe uses whatever
   * state the page is currently in; callers that have driven the page
   * past initial via pass-1 should provide a reset.
   */
  reset?: (page: Page) => Promise<void>;
  /**
   * Wait (ms) after clicking before re-reading state. Mirrors the
   * engine's default settle window. Default: 1500.
   */
  settleMs?: number;
  /**
   * Max time (ms) to wait after reset for the trait's state bridge to
   * report *any* current state. The runtime typically needs a tick to
   * wire `getTraitState` via `bindTraitStateGetter` before any read
   * succeeds; without this wait the sample sees `null`, falls back to
   * `initialState` (usually pre-INIT like `loading`), and picks
   * candidates that don't make sense for the post-INIT page the user
   * actually sees. Default: 5000.
   */
  stateReadyTimeoutMs?: number;
  /** Poll interval (ms) while waiting for state. Default: 150. */
  stateReadyPollMs?: number;
}

/**
 * Candidate selectors for finding a clickable DOM trigger for an event.
 * Mirrors the button-finding heuristics used by `tryTriggerContractEvent`
 * in orbital-verify-unified, in priority order:
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

/**
 * Execute one click-path sample against a running page. Returns a
 * {@link ClickPathSampleCheck} with the outcome for the verifier's
 * report.
 *
 * Picks the first user-dispatchable event whose transition's `from`
 * matches the current bridge state. If none match, returns with
 * `event: null` and a `detail` explaining why the sample was skipped —
 * a legitimate outcome for traits whose every user event requires a
 * non-initial state the walker never navigates to here.
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

  // Poll the bridge until it reports a state for this trait (or we
  // time out). Using the bridge — not the schema's `initialState` —
  // means we sample against the state the user actually lands in
  // after INIT has fired, not the pre-INIT state the schema happens
  // to declare first.
  let stateBefore: string | null = null;
  const deadline = Date.now() + stateReadyTimeoutMs;
  while (Date.now() < deadline) {
    stateBefore = await getTraitCurrentState(page, trait.traitName);
    if (stateBefore !== null) break;
    await page.waitForTimeout(stateReadyPollMs);
  }
  if (stateBefore === null) stateBefore = trait.initialState;

  const candidates = trait.transitions.filter(
    (t) =>
      t.from === stateBefore &&
      trait.userDispatchableEvents.includes(t.event) &&
      !LIFECYCLE_EVENTS.has(t.event),
  );

  if (candidates.length === 0) {
    return {
      traitName: trait.traitName,
      event: null,
      selector: null,
      stateBefore,
      stateAfter: stateBefore,
      passed: false,
      detail:
        `no user-dispatchable event with from=${stateBefore} on trait ${trait.traitName}` +
        ` (user events: [${[...trait.userDispatchableEvents].join(', ')}])`,
    };
  }

  for (const candidate of candidates) {
    for (const selector of selectorsFor(candidate.event)) {
      const clicked = await tryClickSelector(page, selector);
      if (!clicked) continue;

      await page.waitForTimeout(settleMs);
      const stateAfter = await getTraitCurrentState(page, trait.traitName);
      const advanced = stateAfter === candidate.to;

      return {
        traitName: trait.traitName,
        event: candidate.event,
        selector,
        stateBefore,
        stateAfter,
        passed: advanced,
        detail: advanced
          ? `clicked ${selector} → state ${stateBefore} → ${stateAfter}`
          : `clicked ${selector} but state did not advance (expected ${candidate.to}, got ${stateAfter ?? 'null'})`,
      };
    }
  }

  return {
    traitName: trait.traitName,
    event: candidates[0].event,
    selector: null,
    stateBefore,
    stateAfter: stateBefore,
    passed: false,
    detail:
      `no selector matched for event ${candidates[0].event} on trait ${trait.traitName}` +
      ` (tried: ${selectorsFor(candidates[0].event).join(', ')})`,
  };
}
