/**
 * `verdictToChecks` — the single, tool-neutral verdict iteration.
 *
 * Consumer tools (orbital-verify-unified, runtime-verify) previously
 * each rolled their own loop over `ReportShape['verdicts']` to render a
 * pass/fail list, and they diverged (different skip rules, different key
 * casing, different handling of `undefined` slots). This helper is the
 * one canonical fold: it walks `Object.entries(verdicts)`, skips
 * `undefined` slots, and returns one flat entry per DEFINED verdict —
 * both passing and failing — so callers can render the full set.
 *
 * The return shape is deliberately tool-neutral (`{ key, passed,
 * detail }`), NOT the tools' local `VerifyCheck`. Tools map this into
 * their own surface; the kernel never imports a tool's shape.
 *
 * Pure.
 *
 * @packageDocumentation
 */

import type { ReportShape } from './types.js';

/** One tool-neutral check derived from a defined verdict slot. */
export interface VerdictCheck {
  /** The verdict slot key (e.g. `portalSweep`, `crud`, `binding`). */
  key: string;
  passed: boolean;
  detail: string;
}

export function verdictToChecks(
  verdicts: ReportShape['verdicts'],
): ReadonlyArray<VerdictCheck> {
  const out: VerdictCheck[] = [];
  for (const [key, verdict] of Object.entries(verdicts)) {
    if (verdict === undefined) continue;
    out.push({ key, passed: verdict.passed, detail: verdict.detail });
  }
  return out;
}
