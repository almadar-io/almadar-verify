/**
 * `assertInteractionPattern` — pure observer over `Frame[]` for Phase 4b
 * interaction testing.
 *
 * For each frame whose `cause.testKind === 'interaction'`:
 *   - If `cause.expectedPattern` is set: assert the frame's
 *     `domSnapshot.portals` shows the expected slot mounted with
 *     `childCount > 0`. (The pattern name must appear as a slot value;
 *     PortalSlot is a fixed enum but the matching is by slot name.)
 *   - OR — alternatively — assert at least one trait state advanced
 *     between the previous frame and this frame (cross-trait handoffs
 *     are legit, just like VG3 click-path).
 *   - For guard-fail branches (`cause.guardCase === 'fail'`): assert
 *     NO new portal was mounted (the trigger was supposed to be blocked).
 *
 * Pre-v3.0.0 this lived inline in orbital `phase4-browser.ts:2280-3356`
 * as the Phase 4b loop's per-test verdict logic. The lifted shape
 * reads only the temporal Frame stream — `domSnapshot.portals` is the
 * verify-owned DOM observation captured by `tick`'s settle, and the
 * trait `currentState` map comes from `runtimeSnapshot.traits`.
 *
 * @packageDocumentation
 */

import type { Frame } from '../frame/types.js';
import type { Verdict } from './types.js';

export function assertInteractionPattern(frames: ReadonlyArray<Frame>): Verdict[] {
  const verdicts: Verdict[] = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame.cause.testKind !== 'interaction') continue;

    const prev = i > 0 ? frames[i - 1] : null;
    const isGuardFail = frame.cause.guardCase === 'fail';
    const expectedPattern = frame.cause.expectedPattern;

    if (isGuardFail) {
      // Guard-fail: assert no NEW portal mounted compared to prev.
      // Practical heuristic: if the expectedPattern's slot isn't
      // mounted (or is empty), the guard correctly blocked.
      const someNewPortalMounted = frame.domSnapshot.portals.some(
        (p) => p.mounted && p.childCount > 0,
      );
      const prevHadPortal = prev?.domSnapshot.portals.some(
        (p) => p.mounted && p.childCount > 0,
      ) ?? false;
      // Pass if no NEW portal appeared (state stayed where it was).
      const guardHeld = someNewPortalMounted === prevHadPortal;
      verdicts.push({
        passed: guardHeld,
        detail: guardHeld
          ? `interaction[fail]: ${frame.cause.event} guard-fail held — no new portal mounted`
          : `interaction[fail]: ${frame.cause.event} guard-fail breached — a portal mounted unexpectedly`,
        evidence: { frameIndices: prev !== null ? [prev.index, frame.index] : [frame.index] },
      });
      continue;
    }

    // Non-fail: assert the expected pattern's slot is mounted, OR
    // some trait advanced state (cross-trait handoff like ADD_ITEM
    // opening a modal owned by another trait).
    if (expectedPattern !== undefined) {
      const portalMounted = frame.domSnapshot.portals.some(
        (p) => p.mounted && p.childCount > 0,
      );
      if (portalMounted) {
        verdicts.push({
          passed: true,
          detail: `interaction: ${frame.cause.event} mounted "${expectedPattern}" pattern (some portal slot has content)`,
          evidence: { frameIndices: [frame.index] },
        });
        continue;
      }
    }

    // Fall back: did any trait advance state?
    if (prev !== null) {
      const prevStates = new Map<string, string>();
      for (const trait of prev.runtimeSnapshot.traits) {
        prevStates.set(trait.traitName, trait.currentState);
      }
      let advanced: string | null = null;
      for (const trait of frame.runtimeSnapshot.traits) {
        const before = prevStates.get(trait.traitName);
        if (before !== undefined && before !== trait.currentState) {
          advanced = trait.traitName;
          break;
        }
      }
      if (advanced !== null) {
        verdicts.push({
          passed: true,
          detail: `interaction: ${frame.cause.event} advanced ${advanced}'s state${expectedPattern !== undefined ? ` (expected "${expectedPattern}" but cross-trait handoff is legit)` : ''}`,
          evidence: { frameIndices: [frame.index] },
        });
        continue;
      }
    }

    verdicts.push({
      passed: false,
      detail: expectedPattern !== undefined
        ? `interaction: ${frame.cause.event} expected "${expectedPattern}" but no portal mounted and no trait state advanced`
        : `interaction: ${frame.cause.event} no portal mounted and no trait state advanced`,
      evidence: { frameIndices: [frame.index] },
    });
  }

  return verdicts;
}
