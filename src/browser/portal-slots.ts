/**
 * Portal-slot presence check (VG1).
 *
 * When a transition's render-ui effect targets a portal slot
 * (`modal` / `drawer` / `overlay` / `center` / `toast` / `hud-top` /
 * `hud-bottom` / `floating`), the rendered DOM must contain the
 * matching `#slot-{name}` node with at least one child. Conversely,
 * `(render-ui <portal-slot> null)` should leave the slot absent (or
 * empty).
 *
 * This gate closes the class of false-passes tracked as G6 — a
 * transition claims to open a modal, state flips, slot state
 * propagates, but the portal never materializes in the DOM.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import type { ResolvedTrait, ResolvedTraitTransition, SExpr } from '@almadar/core';

/** Canonical portal slot names — must match `packages/almadar-ui/renderer/slot-definitions.ts`. */
export const PORTAL_SLOTS = [
  'modal',
  'drawer',
  'overlay',
  'center',
  'toast',
  'hud-top',
  'hud-bottom',
  'floating',
] as const;

export type PortalSlot = (typeof PORTAL_SLOTS)[number];

export function isPortalSlot(slot: string): slot is PortalSlot {
  return (PORTAL_SLOTS as readonly string[]).includes(slot);
}

/** Single portal-slot probe result. */
export interface PortalSlotCheck {
  slot: PortalSlot;
  /** `null` render-ui value → expect the slot to be absent or empty. */
  expectedPresent: boolean;
  /** Was the slot present and populated in the DOM at probe time? */
  actualPresent: boolean;
  /** Number of direct children in the slot (0 when absent). */
  childCount: number;
  passed: boolean;
  /** Human-readable detail (used by the verifier's report). */
  detail: string;
}

/**
 * Derive the set of portal-slot renders the transition promises.
 *
 * Walks the top-level render-ui effects on the transition. Nested
 * `(render-ui)` calls inside pattern children are uncommon but
 * supported: every render-ui with a portal slot contributes a probe.
 */
export function portalRendersFromTransition(
  transition: ResolvedTraitTransition,
): Array<{ slot: PortalSlot; expectedPresent: boolean }> {
  const out: Array<{ slot: PortalSlot; expectedPresent: boolean }> = [];
  const visit = (node: SExpr): void => {
    if (!Array.isArray(node)) return;
    if (node[0] === 'render-ui' && node.length >= 3) {
      const slot = node[1];
      const pattern = node[2];
      if (typeof slot === 'string' && isPortalSlot(slot)) {
        out.push({ slot, expectedPresent: pattern !== null });
      }
    }
    for (const item of node) visit(item as SExpr);
  };
  for (const effect of transition.effects) visit(effect);
  return out;
}

/**
 * Read portal slot presence from the live DOM.
 *
 * Uses `#slot-<name>` (the canonical ID the runtime's
 * `UISlotRenderer` mounts). Missing slots return `{ present: false,
 * childCount: 0 }`.
 */
async function readPortalSlot(
  page: Page,
  slot: PortalSlot,
): Promise<{ present: boolean; childCount: number; visibleSlots: string[] }> {
  return page.evaluate((s) => {
    const el = document.getElementById(`slot-${s}`);
    const visibleSlots = [...document.querySelectorAll('[id^="slot-"]')]
      .map((n) => n.id)
      .filter((id, i, arr) => arr.indexOf(id) === i);
    if (!el) return { present: false, childCount: 0, visibleSlots };
    return { present: true, childCount: el.children.length, visibleSlots };
  }, slot);
}

/** An expected portal render the caller has already derived. */
export interface ExpectedPortalRender {
  slot: PortalSlot;
  /** `true` when the transition's render-ui provided content; `false` on clear. */
  expectedPresent: boolean;
}

/** Options controlling the DOM probe's retry behavior. */
export interface PortalProbeOptions {
  /**
   * Max time (ms) to wait for an expected-present slot to mount content
   * before calling it a fail. Runtime paths can paint portals a few
   * hundred ms after the state transition; a single-shot check at
   * t=0 produced timing-race false-fails. Default: 3000.
   */
  mountTimeoutMs?: number;
  /**
   * Settle window (ms) to wait before checking that an expected-absent
   * (cleared) slot actually cleared. Short by design — clears shouldn't
   * need much time, and a long wait here punishes every clear probe
   * for no signal. Default: 300.
   */
  clearSettleMs?: number;
  /** Poll interval (ms) while waiting for a mount. Default: 100. */
  pollMs?: number;
}

/**
 * Wait for a portal slot to match `expectedPresent`, or fall through on
 * timeout. Returns the final observation — the caller decides PASS/FAIL
 * against that. For the expected-present case, polls up to
 * `mountTimeoutMs`; for expected-absent, polls for a short `clearSettleMs`
 * window and returns whatever it saw last.
 */
async function waitForPortalSlotState(
  page: Page,
  slot: PortalSlot,
  expectedPresent: boolean,
  options: Required<Pick<PortalProbeOptions, 'mountTimeoutMs' | 'clearSettleMs' | 'pollMs'>>,
): Promise<{ present: boolean; childCount: number; visibleSlots: string[] }> {
  const deadline = Date.now() + (expectedPresent ? options.mountTimeoutMs : options.clearSettleMs);
  let last = await readPortalSlot(page, slot);
  while (Date.now() < deadline) {
    const rendered = last.present && last.childCount > 0;
    if (expectedPresent ? rendered : !rendered) return last;
    await page.waitForTimeout(options.pollMs);
    last = await readPortalSlot(page, slot);
  }
  return last;
}

/**
 * Low-level portal probe. Runs a DOM check for each expected render,
 * with retry-with-backoff so runtime-path modals that paint a few
 * hundred ms after the state transition aren't misreported as missing.
 *
 * Callers that already have the expected slot list (e.g. derived from
 * an extracted render-effect array instead of the full OIR) use this
 * directly; callers with a `ResolvedTraitTransition` in hand should
 * use {@link probePortalSlotsAfterTransition}, which wraps this.
 */
export async function probePortalSlots(
  page: Page,
  expected: readonly ExpectedPortalRender[],
  options: PortalProbeOptions = {},
): Promise<PortalSlotCheck[]> {
  if (expected.length === 0) return [];
  const opts = {
    mountTimeoutMs: options.mountTimeoutMs ?? 3000,
    clearSettleMs: options.clearSettleMs ?? 300,
    pollMs: options.pollMs ?? 100,
  };
  const results: PortalSlotCheck[] = [];
  for (const { slot, expectedPresent } of expected) {
    const { present, childCount, visibleSlots } = await waitForPortalSlotState(page, slot, expectedPresent, opts);
    const rendered = present && childCount > 0;
    const passed = expectedPresent ? rendered : !rendered;
    // When a mount probe fails, include the set of slot-* IDs that ARE in
    // the DOM. Distinguishes two failure modes: slot element never created
    // (trait not subscribed / not re-rendered) vs element exists but empty
    // (content didn't flow). Cheap to capture and makes debugging VG15
    // considerably faster.
    const slotsDump = visibleSlots.length > 0
      ? ` [slots present: ${visibleSlots.join(', ')}]`
      : ` [no slots mounted]`;
    const detail = expectedPresent
      ? rendered
        ? `#slot-${slot} rendered with ${childCount} child(ren)`
        : `#slot-${slot} expected content but ${present ? 'slot is empty' : 'slot not mounted'} after ${opts.mountTimeoutMs}ms${slotsDump}`
      : rendered
        ? `#slot-${slot} expected to be cleared but has ${childCount} child(ren) after ${opts.clearSettleMs}ms`
        : `#slot-${slot} cleared as expected`;
    results.push({
      slot,
      expectedPresent,
      actualPresent: rendered,
      childCount,
      passed,
      detail,
    });
  }
  return results;
}

/**
 * Run portal-slot probes for a transition's expected renders.
 * Returns one {@link PortalSlotCheck} per render-ui to a portal slot.
 * Callers aggregate the results into their check list / report.
 */
export async function probePortalSlotsAfterTransition(
  page: Page,
  transition: ResolvedTraitTransition,
  options?: PortalProbeOptions,
): Promise<PortalSlotCheck[]> {
  return probePortalSlots(page, portalRendersFromTransition(transition), options);
}

/**
 * Convenience lookup: given a trait's IR and the `(from, event, to)`
 * triple the walker just fired, return the transition so probes can
 * introspect its effects. Returns `null` if no matching transition
 * exists.
 */
export function findTransition(
  trait: ResolvedTrait,
  from: string,
  event: string,
  to: string,
): ResolvedTraitTransition | null {
  for (const t of trait.transitions) {
    if (t.event !== event) continue;
    if (t.to !== to) continue;
    if (typeof t.from === 'string') {
      if (t.from === from || t.from === '*') return t;
    } else if (Array.isArray(t.from)) {
      if (t.from.includes(from)) return t;
    }
  }
  return null;
}
