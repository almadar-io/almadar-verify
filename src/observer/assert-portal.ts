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
 * Pure.
 *
 * @packageDocumentation
 */

import type { Frame } from '../frame/types.js';
import type { Verdict } from './types.js';

export function assertPortalSlots(frames: ReadonlyArray<Frame>): Verdict {
  const offenders: string[] = [];
  const indices: number[] = [];

  for (const frame of frames) {
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
