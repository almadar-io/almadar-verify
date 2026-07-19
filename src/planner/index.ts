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

export { planWalk } from './plan-walk.js';
export { planInitCredit } from './plan-init-credit.js';
export { planEmitSweep } from './plan-emit-sweep.js';
export { planReplayTo } from './plan-replay-to.js';
export { planTickTests } from './plan-tick-tests.js';
export {
  decorateWithTriggerKind,
  type DecorateInput,
} from './plan-dom-decoration.js';
export { planClickPathSamples } from './plan-click-path-samples.js';
export { extractTraitWalkConfigs } from './extract-trait-walk-configs.js';
export {
  planContractEvents,
  type ContractRegistry,
  type ContractRegistryEntry,
} from './plan-contract-events.js';
export { planDataMutationTests } from './plan-data-mutation-tests.js';
export { planInteractionTests } from './plan-interaction-tests.js';
