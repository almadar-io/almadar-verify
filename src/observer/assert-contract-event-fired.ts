/**
 * `assertContractEventFired` — pure observer over `Frame[]` for Phase 4c
 * contract event coverage.
 *
 * For each frame whose `cause.testKind === 'contract'`:
 *   - Check `frame.eventLogDelta.added` for an entry whose `type`
 *     matches `cause.event`. If found → the dispatch landed.
 *   - Check `frame.consoleDelta.newErrors === 0`. If errors fired,
 *     the trigger broke something.
 *   - Both pass → verdict passed.
 *
 * Pre-v3.0.0 this lived in orbital as imperative DOM-driving + a JS
 * error listener. The lifted shape reads only the temporal Frame
 * stream (each Frame's `eventLogDelta.added` is the canonical core
 * `EventLogEntry[]`; `consoleDelta.newErrors` is verify's Playwright
 * console capture).
 *
 * @packageDocumentation
 */

import type { Frame } from '../frame/types.js';
import type { Verdict } from './types.js';

export function assertContractEventFired(frames: ReadonlyArray<Frame>): Verdict[] {
  const verdicts: Verdict[] = [];

  for (const frame of frames) {
    if (frame.cause.testKind !== 'contract') continue;

    const eventName = frame.cause.event;
    const fired = frame.eventLogDelta.added.some((entry) => entry.type === eventName);
    const newErrors = frame.consoleDelta.newErrors;

    if (!fired) {
      verdicts.push({
        passed: false,
        detail: `contract: ${eventName} did not fire — no entry in eventLog after settle`,
        evidence: { frameIndices: [frame.index] },
      });
      continue;
    }

    if (newErrors > 0) {
      const firstErr = frame.consoleDelta.added.find((e) => e.type === 'error');
      verdicts.push({
        passed: false,
        detail: `contract: ${eventName} fired but produced ${newErrors} JS error(s)${firstErr !== undefined ? ` — ${firstErr.text.slice(0, 200)}` : ''}`,
        evidence: { frameIndices: [frame.index] },
      });
      continue;
    }

    verdicts.push({
      passed: true,
      detail: `contract: ${eventName} fired cleanly (no JS errors)`,
      evidence: { frameIndices: [frame.index] },
    });
  }

  return verdicts;
}
