/**
 * `decorateWithTriggerKind` — pure pass over an `ExtendedWalkStep[]`
 * that flips eligible non-init / non-replay steps from `bus` to `dom`,
 * marking them as DOM-trigger steps the driver should attempt to fire
 * via a real button click rather than `sendEvent`.
 *
 * Eligibility: a step's event must appear in the trait's set of
 * UI-bindable events (events that have a corresponding render-ui
 * action / button binding). Callers compute that set up-front from the
 * trait's effects (`collectInteractionEvents` or similar) and hand it
 * to this planner.
 *
 * The driver's `triggerDOM` impl falls back to `sendEvent` if the DOM
 * affordance can't be located, so DOM tagging is never destructive.
 *
 * Pure.
 *
 * @packageDocumentation
 */

import type { ExtendedWalkStep } from './types.js';

export interface DecorateInput {
  steps: ReadonlyArray<ExtendedWalkStep>;
  /** Set of event names that have visible DOM affordances. */
  domEvents: ReadonlySet<string>;
}

export function decorateWithTriggerKind(input: DecorateInput): ExtendedWalkStep[] {
  const { steps, domEvents } = input;
  return steps.map((step) => {
    if (step.triggerKind === 'auto-init' || step.triggerKind === 'replay') {
      return step;
    }
    if (domEvents.has(step.event)) {
      return { ...step, triggerKind: 'dom' };
    }
    return step;
  });
}
