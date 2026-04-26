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
} from './types.js';

export { planWalk } from './plan-walk.js';
export { planInitCredit } from './plan-init-credit.js';
export { planEmitSweep } from './plan-emit-sweep.js';
export { planReplayTo } from './plan-replay-to.js';
export {
  decorateWithTriggerKind,
  type DecorateInput,
} from './plan-dom-decoration.js';
export {
  planClickPathSamples,
  type PlanClickPathInput,
  type RenderSiteSpec,
} from './plan-click-path-samples.js';
export {
  planContractEvents,
  type PlanContractEventsInput,
} from './plan-contract-events.js';
export {
  planDataMutationTests,
  type PlanDataMutationTestsInput,
  type DataMutationTestSpec,
} from './plan-data-mutation-tests.js';
export {
  planInteractionTests,
  type PlanInteractionTestsInput,
  type InteractionTestSpec,
} from './plan-interaction-tests.js';
