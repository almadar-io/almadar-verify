/**
 * `planner/` — pure planners that turn a trait into an ordered list of
 * `ExtendedWalkStep`s the driver fires via `tick()`.
 *
 * @packageDocumentation
 */

export type {
  ExtendedWalkStep,
  PlanWalkInput,
  PlanEmitInput,
  PlanReplayInput,
  PlanTickInput,
} from './types.js';

export {
  decorateWithTriggerKind,
  type DecorateInput,
} from './plan-dom-decoration.js';
export { planClickPathSamples } from './plan-click-path-samples.js';
export { extractTraitWalkConfigs } from './extract-trait-walk-configs.js';
export { planInteractionTests } from './plan-interaction-tests.js';
