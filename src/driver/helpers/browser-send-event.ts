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
  if (!ready) return false;
  // Pin page.evaluate to a concrete signature: Playwright's generic
  // Unboxing/SmartHandle mapped types recurse SendEventArgs' SExpr payload
  // past tsc's instantiation depth (TS2589). The assertion is between
  // overlapping function types — no any/unknown.
  const evaluateSendEvent = page.evaluate as (
    fn: (arg: SendEventArgs) => boolean,
    arg: SendEventArgs,
  ) => Promise<boolean>;
  const result = await evaluateSendEvent(browserSendEvent, args);
  return result === true;
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
