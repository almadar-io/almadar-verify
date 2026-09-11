/**
 * `scanRenderUiEffect` — project one effect node into `{ slot, pattern }`,
 * or `null` when the node is not a scannable render-ui effect.
 *
 * Single owner: `derivePortalExpectations` (pipeline) and
 * `transient-failure-arm.ts` (planner) both need to read a transition's
 * own render-ui declaration the same way — lifted here instead of
 * duplicating the scan.
 *
 * @packageDocumentation
 */

import type { Effect, SExpr } from '@almadar/core';

/**
 * `pattern: null` means the transition explicitly clears the slot (no
 * payload / no `type` key). A payload whose `type` is present but NOT a
 * literal string is a reactive binding — the pattern is unknown, so the
 * effect is skipped entirely rather than asserted as a cleared slot.
 */
export function scanRenderUiEffect(effect: Effect | SExpr): { slot: string; pattern: string | null } | null {
  if (!Array.isArray(effect)) return null;
  if (effect[0] !== 'render-ui') return null;
  const slot = typeof effect[1] === 'string' ? effect[1] : null;
  if (slot === null) return null;
  const payload = effect[2];
  if (payload !== null && payload !== undefined && typeof payload === 'object' && !Array.isArray(payload)) {
    const t = (payload as Readonly<Record<string, SExpr>>)['type'];
    // A reactive binding — string form (`'@config.x'`) or an S-expr —
    // resolves at runtime; the pattern is UNKNOWN, so skip the effect
    // rather than assert anything (pre-fix this fell through to
    // `pattern: null`, which asserts the slot was CLEARED).
    if (typeof t === 'string' && t.startsWith('@')) return null;
    if (t !== undefined && typeof t !== 'string') return null;
    if (typeof t === 'string') return { slot, pattern: t };
  }
  return { slot, pattern: null };
}
