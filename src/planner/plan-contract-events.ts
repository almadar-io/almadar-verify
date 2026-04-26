/**
 * `planContractEvents` — pure planner that produces one DOM-trigger
 * step per declared cross-orbital contract emit so Phase 4c becomes
 * part of the Frame stream.
 *
 * Pre-v3.0.0 this lived in orbital `phase4-browser.ts:3656-3789`. That
 * code navigated to each route, scanned `[data-pattern]` elements,
 * looked up the pattern's contract from `event-contracts.json`, and
 * imperatively tried to trigger each non-optional emit, checking for
 * JS errors after each attempt.
 *
 * The lifted shape: the consumer (orbital, runtime-verify) loads the
 * contract registry, computes the set of event names to test (filtering
 * out events already covered by interaction tests), and hands the
 * planner a flat `string[]`. Each name becomes one
 * `ExtendedWalkStep` with `triggerKind: 'dom'` and
 * `testKind: 'contract'`. The kernel's `tick` fires it via Driver
 * (DOM-first, fallback to bus). `assertContractEventFired` (pure
 * observer) reads `frame.eventLogDelta.added` to verify the event
 * actually fired and `frame.consoleDelta.newErrors === 0`.
 *
 * Pure. No `Page`. No filesystem. No DOM.
 *
 * @packageDocumentation
 */

import type { TraitWalkConfig } from '../engine/types.js';
import type { ExtendedWalkStep } from './types.js';

export interface PlanContractEventsInput {
  /** Traits the kernel is walking. */
  traits: ReadonlyArray<TraitWalkConfig>;
  /**
   * Event names to test. The consumer extracts these from the
   * contract registry, filters out optional emits + events already
   * covered by other planner extensions (interaction tests, walker
   * pass-1).
   */
  events: ReadonlyArray<string>;
}

/**
 * One step per event. All steps are anchored under the FIRST trait in
 * the input — contract events are pattern-scoped (not trait-scoped),
 * so we just need a routing context. The kernel's `tick` fires via
 * Driver.triggerDOM (DOM-first). If no affordance is found, tick
 * falls back to `sendEvent`. Either way the event lands in
 * `frame.eventLogDelta.added` and the observer sees it.
 *
 * Returns [] if `traits` is empty (no anchor available).
 */
export function planContractEvents(input: PlanContractEventsInput): ExtendedWalkStep[] {
  if (input.traits.length === 0 || input.events.length === 0) return [];

  const anchor = input.traits[0];
  const result: ExtendedWalkStep[] = [];
  const seen = new Set<string>();

  for (const event of input.events) {
    if (seen.has(event)) continue;
    seen.add(event);

    result.push({
      from: anchor.initialState,
      event,
      to: anchor.initialState,
      guardCase: null,
      payload: {},
      isRepositioning: false,
      traitName: anchor.traitName,
      triggerKind: 'dom',
      coverageKey: `${anchor.traitName}:${anchor.initialState}+${event}->${anchor.initialState}[contract]`,
      testKind: 'contract',
    });
  }

  return result;
}
