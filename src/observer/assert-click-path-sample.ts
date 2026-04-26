/**
 * `assertClickPathSample` — pure observer over `Frame[]` for VG3.
 *
 * For each frame whose `cause.testKind === 'click-path'`:
 *   - Compare the trait `currentState` map between this frame and the
 *     previous frame.
 *   - If ANY trait's state changed → passed (the click drove the bus
 *     and the reducer responded; cross-trait handoffs count).
 *   - If NO trait advanced → failed: the button's selector matched but
 *     the click didn't reach the reducer. Likely a dead event key or
 *     a guard rejection.
 *
 * Pre-v3.0.0 this lived in orbital as `sampleClickPathsPerSite` —
 * a Page-bound function that drove DOM imperatively. The lifted shape
 * is purely temporal: tick fires the click via Driver, the resulting
 * Frame carries the post-settle runtime snapshot, and this observer
 * reads it.
 *
 * @packageDocumentation
 */

import type { Frame } from '../frame/types.js';
import type { Verdict } from './types.js';

export function assertClickPathSample(frames: ReadonlyArray<Frame>): Verdict[] {
  const verdicts: Verdict[] = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame.cause.testKind !== 'click-path') continue;

    const prev = i > 0 ? frames[i - 1] : null;
    if (prev === null) {
      verdicts.push({
        passed: false,
        detail: `click-path: frame ${frame.index} (${frame.cause.event}) has no previous frame for state comparison`,
        evidence: { frameIndices: [frame.index] },
      });
      continue;
    }

    const prevStates = new Map<string, string>();
    for (const trait of prev.runtimeSnapshot.traits) {
      prevStates.set(trait.traitName, trait.currentState);
    }
    const thisStates = new Map<string, string>();
    for (const trait of frame.runtimeSnapshot.traits) {
      thisStates.set(trait.traitName, trait.currentState);
    }

    let advancedTrait: string | null = null;
    for (const [name, state] of thisStates) {
      const before = prevStates.get(name);
      if (before !== undefined && before !== state) {
        advancedTrait = name;
        break;
      }
    }

    // A click-path sample passes if either:
    //   1. The dispatch advanced some trait's state, OR
    //   2. `frame.accepted` is true (the runtime guard-accepted the
    //      transition — handles self-loop transitions like `loading
    //      INIT loading` where state correctly doesn't change but the
    //      click did reach the reducer).
    // Pre-fix this only checked (1), which false-failed every Refresh /
    // Retry button wired to an INIT self-loop.
    const passed = advancedTrait !== null || frame.accepted;
    verdicts.push({
      passed,
      detail: advancedTrait !== null
        ? `click-path: ${frame.cause.event} advanced ${advancedTrait}'s state`
        : passed
          ? `click-path: ${frame.cause.event} dispatch accepted (self-loop transition)`
          : `click-path: ${frame.cause.event} did not advance any trait state — affordance likely wired to a dead event key`,
      evidence: { frameIndices: [frame.index] },
    });
  }

  return verdicts;
}
