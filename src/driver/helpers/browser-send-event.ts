/**
 * `dispatchInBrowser` — the single owner of "dispatch an event into the
 * runtime via `window.__orbitalVerification.sendEvent`". Used by the
 * Playwright driver's `sendEvent` impl AND by the DOM trigger when a
 * CRUD step's affordance doesn't exist in the DOM but the event still
 * needs a payload-correct dispatch (e.g. crud-delete's `id`).
 *
 * Extracted to top-level so TS doesn't re-infer the page.evaluate
 * callback signature through Playwright's overload chain on every call
 * site (which trips the "excessively deep" check).
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import type { EventPayload, OrbitalVerificationAPI } from '@almadar/core';

interface SendEventArgs {
  ev: string;
  pl: EventPayload;
  sc: string | undefined;
}

export async function dispatchInBrowser(
  page: Page,
  event: string,
  payload: EventPayload,
  traitScope?: string,
): Promise<boolean> {
  // page.evaluate's `arg` parameter wants a serializable type.
  // EventPayload is recursively-typed (values can be EventPayload),
  // which trips Playwright's overload inference into "excessively
  // deep" depth-bounded recursion when the arg type is inferred. The
  // explicit `SendEventArgs` annotation on the evaluate call pins the
  // generic so inference never recurses — payload stays EventPayload
  // end to end, no erasure.
  const args: SendEventArgs = {
    ev: event,
    pl: payload,
    sc: traitScope,
  };
  // Readiness gate: the hermetic reset navigates on `domcontentloaded`,
  // which can land BEFORE the playground hydrates VerificationProvider
  // and installs `__orbitalVerification`. Dispatching in that window
  // silently no-ops ("driver did not deliver") and the whole walk
  // diverges — a timing flake, not a real wiring failure. Wait for the
  // bridge api itself (the exact precondition of the evaluate below);
  // already-hydrated pages pass in ~1ms.
  const ready = await page
    .waitForFunction(browserBridgeReady, undefined, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    console.error(`[dispatch] bridge-not-ready: event=${event} scope=${traitScope ?? ''}`);
    return false;
  }
  // Pin page.evaluate to a concrete signature: Playwright's generic
  // Unboxing/SmartHandle mapped types recurse SendEventArgs' SExpr payload
  // past tsc's instantiation depth (TS2589). The assertion is between
  // overlapping function types — no any/unknown. MUST stay `.bind(page)`:
  // a bare `page.evaluate as (...)` detaches the method, `this` is
  // undefined at the call, and Playwright's first deref (`this._mainFrame`)
  // throws on EVERY dispatch — the walk-killing "_mainFrame" failure.
  const evaluateSendEvent = page.evaluate.bind(page) as (
    fn: (arg: SendEventArgs) => boolean,
    arg: SendEventArgs,
  ) => Promise<boolean>;
  const result = await evaluateSendEvent(browserSendEvent, args).catch(async (err: Error) => {
    // A prior dispatch can trigger a client-side navigation (itemAction
    // routing, page-decl hrefs); an evaluate racing that document swap dies
    // on a detached frame (Playwright surfaces it as `_mainFrame` of
    // undefined or "Execution context was destroyed") and previously
    // aborted the WHOLE walk. Re-arm on the new document and retry once;
    // a second failure reports "not delivered" exactly like the readiness
    // gate above. Genuine teardown (browser/context closed) stays fatal.
    if (!isNavigationRace(err)) throw err;
    console.error(`[dispatch] nav-race caught: event=${event} scope=${traitScope ?? ''} — re-arming`);
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
    const rearmed = await page
      .waitForFunction(browserBridgeReady, undefined, { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!rearmed) {
      console.error(`[dispatch] nav-race re-arm failed: event=${event}`);
      return false;
    }
    return evaluateSendEvent(browserSendEvent, args).catch((retryErr: Error) => {
      console.error(`[dispatch] nav-race retry failed: event=${event} err=${retryErr.message}`);
      return false;
    });
  });
  if (result !== true) console.error(`[dispatch] sendEvent returned ${String(result)}: event=${event} scope=${traitScope ?? ''}`);
  return result === true;
}

function isNavigationRace(err: Error): boolean {
  const m = err.message;
  return (
    m.includes("reading '_mainFrame'") ||
    m.includes('Execution context was destroyed') ||
    m.includes('Frame was detached') ||
    m.includes('frame was detached')
  );
}

function browserBridgeReady(): boolean {
  const api = (window as Window & { __orbitalVerification?: OrbitalVerificationAPI }).__orbitalVerification;
  return typeof api?.sendEvent === 'function';
}

function browserSendEvent(a: SendEventArgs): boolean {
  const api = (window as Window & { __orbitalVerification?: OrbitalVerificationAPI }).__orbitalVerification;
  if (api?.sendEvent === undefined) return false;
  api.sendEvent(a.ev, a.pl, a.sc);
  return true;
}
