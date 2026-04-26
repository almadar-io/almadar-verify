/**
 * `assertCascade` — pure observer over the bus event log + per-trait
 * `cascadeReceived` arrays.
 *
 * Counts cascade events the runtime emitted as a result of the rule's
 * `(traitName, event)` transition firing, asserts the count is within
 * `[minCascade, maxCascade]`. Lifted from `probeCascadeCount` /
 * `probeCascadeFlowDelta` (browser/catalog-probes.ts) so the same
 * check lives once and runs over any Frame stream.
 *
 * Reads `Frame.runtimeSnapshot.traits[*].cascadeReceived` (core type)
 * — no DOM probing, no Page parameter.
 *
 * @packageDocumentation
 */

import type { Frame } from '../frame/types.js';
import type { CascadeRule, Verdict } from './types.js';

export function assertCascade(
  frames: ReadonlyArray<Frame>,
  rule: CascadeRule,
): Verdict {
  // Find every frame whose cause matches the rule (the dispatching
  // transition). For each, the cascade count is read from the next
  // frame's runtime snapshot's cascadeReceived array on the named
  // trait — that's where the runtime accumulates emitted events the
  // bus delivered between the dispatch and the next snapshot.
  const matchingFrames: Frame[] = [];
  for (const frame of frames) {
    if (
      frame.cause.traitName === rule.traitName &&
      frame.cause.event === rule.event
    ) {
      matchingFrames.push(frame);
    }
  }

  if (matchingFrames.length === 0) {
    return {
      passed: false,
      detail: `assertCascade: no frame fired ${rule.traitName}.${rule.event}`,
      evidence: { frameIndices: [] },
    };
  }

  const failures: string[] = [];
  const indices: number[] = [];

  for (const frame of matchingFrames) {
    const traitSnapshot = frame.runtimeSnapshot.traits.find(
      (t) => t.traitName === rule.traitName,
    );
    if (traitSnapshot === undefined) {
      failures.push(`frame ${frame.index}: no runtime snapshot for trait ${rule.traitName}`);
      indices.push(frame.index);
      continue;
    }
    const cascadeCount = traitSnapshot.cascadeReceived.length;
    const tooFew = cascadeCount < rule.minCascade;
    const tooMany = rule.maxCascade !== undefined && cascadeCount > rule.maxCascade;
    if (tooFew || tooMany) {
      failures.push(
        `frame ${frame.index}: cascade count ${cascadeCount} outside [${rule.minCascade}, ${rule.maxCascade ?? '∞'}]`,
      );
    }
    indices.push(frame.index);
  }

  if (failures.length > 0) {
    return {
      passed: false,
      detail: `assertCascade: ${rule.traitName}.${rule.event} failed cascade bounds — ${failures.join('; ')}`,
      evidence: { frameIndices: indices },
    };
  }

  return {
    passed: true,
    detail: `assertCascade: ${rule.traitName}.${rule.event} cascade count within bounds across ${matchingFrames.length} frame(s)`,
    evidence: { frameIndices: indices },
  };
}
