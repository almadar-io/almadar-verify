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

/**
 * `assertBusItemCascadedNTimes` — one bus item cascaded MORE THAN ONCE
 * into one listener within a single dispatch window. `cascadeReceived`
 * (`TraitStateSnapshot`, core) resets "since the last user dispatch", so
 * two entries in ONE frame's list for the SAME `(event, payload)` pair on
 * the SAME trait is a genuine duplicate delivery, not two distinct real
 * firings — a bus double-dispatch / double-subscription bug, not a
 * legitimately-repeated event (which would carry a DIFFERENT payload).
 * Matched by `(event, JSON.stringify(payload))` — never by event name
 * alone, so a route that fires the same event twice with different data
 * in one window stays silent.
 */
export function assertBusItemCascadedNTimes(frames: ReadonlyArray<Frame>): Verdict[] {
  const verdicts: Verdict[] = [];
  for (const frame of frames) {
    for (const traitSnapshot of frame.runtimeSnapshot.traits) {
      const counts = new Map<string, { event: string; count: number }>();
      for (const item of traitSnapshot.cascadeReceived) {
        const key = `${item.event}::${JSON.stringify(item.payload ?? {})}`;
        const entry = counts.get(key) ?? { event: item.event, count: 0 };
        entry.count += 1;
        counts.set(key, entry);
      }
      for (const { event, count } of counts.values()) {
        if (count <= 1) continue;
        verdicts.push({
          passed: false,
          detail:
            `bus-item-cascaded-n-times: ${traitSnapshot.traitName} received the SAME bus item ('${event}') ` +
            `${count} times in one dispatch window (frame ${frame.index}) — a duplicate delivery, not ${count} ` +
            `distinct firings`,
          evidence: { frameIndices: [frame.index] },
        });
      }
    }
  }
  return verdicts;
}
