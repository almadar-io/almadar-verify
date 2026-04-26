/**
 * `assertRefTraitInvariantOverFrames` — pure observer that asserts every
 * trait the runtime exposes has a healthy snapshot:
 *  - non-empty `states[]`
 *  - non-empty `events[]`
 *  - `currentState` ∈ `states`
 *
 * Lifts `assertRefTraitInvariant` (browser/ref-trait-invariant.ts) into
 * Frame-shaped territory. We sample the LAST frame in the stream (by
 * convention, the most settled state); a stricter version could check
 * every frame.
 *
 * @packageDocumentation
 */

import type { Frame } from '../frame/types.js';
import type { Verdict } from './types.js';

export function assertRefTraitInvariantOverFrames(
  frames: ReadonlyArray<Frame>,
): Verdict {
  if (frames.length === 0) {
    return {
      passed: false,
      detail: 'assertRefTraitInvariant: no frames to inspect',
      evidence: { frameIndices: [] },
    };
  }

  const lastFrame = frames[frames.length - 1];
  const failures: string[] = [];

  for (const trait of lastFrame.runtimeSnapshot.traits) {
    if (trait.states.length === 0) {
      failures.push(`${trait.traitName}: states[] is empty`);
      continue;
    }
    if (trait.events.length === 0) {
      failures.push(`${trait.traitName}: events[] is empty`);
      continue;
    }
    if (!trait.states.includes(trait.currentState)) {
      failures.push(
        `${trait.traitName}: currentState "${trait.currentState}" not in states [${trait.states.join(', ')}]`,
      );
    }
  }

  if (failures.length === 0) {
    return {
      passed: true,
      detail: `assertRefTraitInvariant: ${lastFrame.runtimeSnapshot.traits.length} trait(s) healthy on frame ${lastFrame.index}`,
      evidence: { frameIndices: [lastFrame.index] },
    };
  }

  return {
    passed: false,
    detail: `assertRefTraitInvariant: ${failures.length} failure(s) on frame ${lastFrame.index} — ${failures.join('; ')}`,
    evidence: { frameIndices: [lastFrame.index] },
  };
}
