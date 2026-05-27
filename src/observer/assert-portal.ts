/**
 * `assertPortalSlots` — pure observer over `Frame.domSnapshot.portals`.
 *
 * Lifts `probePortalSlots` / `probePortalSlotsAfterTransition` from
 * `browser/portal-slots.ts` into a Frame-based observer. Asserts that
 * the trait's expected portal slots (main, modal, sheet, drawer, etc.)
 * are mounted with the expected child counts.
 *
 * The rule is implicit here — we just check that NO frame ends with a
 * mounted portal slot that has zero children (a "blank portal" bug).
 * Stricter rules (specific slot must be mounted on specific transition)
 * can be layered on top by callers.
 *
 * Side-effect-only traits (capability `lifecycle`) opt out: these are
 * audit / notification / cascade / row-access atoms that intentionally
 * don't render. Their slots ARE mounted (the shell mounts every slot),
 * but they're empty by design — flagging them as "blank-portal bugs"
 * was a false positive. The caller passes `noRenderTraits` so the
 * observer can skip frames originating from those traits.
 *
 * Pure.
 *
 * @packageDocumentation
 */

import type { Frame } from '../frame/types.js';
import type { Verdict } from './types.js';

export interface AssertPortalOptions {
  /**
   * Traits that explicitly don't render UI (capability `lifecycle`).
   * Frames whose `cause.traitName` is in this set are skipped — their
   * empty portals are expected, not bugs.
   */
  noRenderTraits?: ReadonlySet<string>;
}

export function assertPortalSlots(
  frames: ReadonlyArray<Frame>,
  options: AssertPortalOptions = {},
): Verdict {
  const offenders: string[] = [];
  const indices: number[] = [];
  const noRender = options.noRenderTraits ?? new Set<string>();

  for (const frame of frames) {
    if (noRender.has(frame.cause.traitName)) continue;
    for (const portal of frame.domSnapshot.portals) {
      if (portal.mounted && portal.childCount === 0) {
        offenders.push(`frame ${frame.index}: slot "${portal.slot}" mounted but empty`);
        indices.push(frame.index);
      }
    }
  }

  if (offenders.length === 0) {
    return {
      passed: true,
      detail: `assertPortalSlots: no blank-portal frames across ${frames.length} frame(s)`,
      evidence: { frameIndices: [] },
    };
  }

  return {
    passed: false,
    detail: `assertPortalSlots: ${offenders.length} blank-portal occurrence(s) — ${offenders.slice(0, 3).join('; ')}${offenders.length > 3 ? '; …' : ''}`,
    evidence: { frameIndices: indices },
  };
}
