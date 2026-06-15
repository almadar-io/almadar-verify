/**
 * Browser-safe exports from @almadar-io/verify.
 *
 * This entrypoint excludes everything that depends on Playwright
 * or Node.js built-ins (fs, path, etc.). It is safe to bundle into
 * a Vite / webpack client build.
 *
 * @packageDocumentation
 */

// Pipeline
export type { RunVerificationInput, RunVerificationOutput } from './pipeline/types.js';
export { runVerification } from './pipeline/index.js';

// Config sweep (Storybook-style variants — vary trait config, snapshot each)
export { runConfigSweep } from './pipeline/run-config-sweep.js';
export type {
  ConfigSweepInput,
  ConfigSweepResult,
  ConfigSweepVariant,
} from './pipeline/run-config-sweep.js';
export { enumerateConfigVariants } from './planner/enumerate-config-variants.js';
export type { ConfigVariant } from './planner/enumerate-config-variants.js';

// Driver contract (types + tick only — no Playwright impls)
export type { Driver, DriverContext, SendResult, SnapshotResult } from './driver/types.js';
export { tick } from './driver/tick.js';
export type { ExtendedWalkStep } from './planner/types.js';
export type { TraitWalkConfig } from './engine/types.js';

// Planners
export type { PlanWalkInput, PlanEmitInput, PlanReplayInput } from './planner/types.js';
export { planWalk } from './planner/plan-walk.js';
export { planInitCredit } from './planner/plan-init-credit.js';
export { planEmitSweep } from './planner/plan-emit-sweep.js';
export { planReplayTo } from './planner/plan-replay-to.js';
export { decorateWithTriggerKind } from './planner/plan-dom-decoration.js';
export { planClickPathSamples } from './planner/plan-click-path-samples.js';
export { extractTraitWalkConfigs } from './planner/extract-trait-walk-configs.js';
export type { ContractRegistry, ContractRegistryEntry } from './planner/plan-contract-events.js';
export { planContractEvents } from './planner/plan-contract-events.js';
export { planDataMutationTests } from './planner/plan-data-mutation-tests.js';
export { planInteractionTests } from './planner/plan-interaction-tests.js';
export { planUserCrudFlow } from './planner/plan-user-crud-flow.js';

// Observers
export type { Observer, CoverageMetric, Verdict, ReportShape } from './observer/types.js';
export { coverage } from './observer/coverage.js';
export { assertMutation } from './observer/assert-mutation.js';
export { assertCascade } from './observer/assert-cascade.js';
export { assertPortalSlots } from './observer/assert-portal.js';
export { probeBindings as probeBindingsFromFrame } from './observer/probe-bindings.js';
export { assertRefTraitInvariantOverFrames } from './observer/assert-ref-trait-invariant.js';
export { assertClickPathSample } from './observer/assert-click-path-sample.js';
export { assertContractEventFired } from './observer/assert-contract-event-fired.js';
export { assertDataMutation } from './observer/assert-data-mutation.js';
export { assertCrudFlow } from './observer/assert-crud-flow.js';
export { assertPortalPerStep } from './observer/assert-portal-per-step.js';
export { assertInteractionPattern } from './observer/assert-interaction-pattern.js';
export { report as buildFrameReport } from './observer/report.js';

// Frame
export type { Frame, FrameCause, TriggerKind, TestKind, ConsoleDelta, EventLogDelta, EntityChange, EntityRowChange, DomSnapshot } from './frame/types.js';
export { keyOf, diffConsole, diffEventLog, diffEntities, makeWalkFrame, makeInitFrame } from './frame/factory.js';

// Pure catalog probes
export {
  collectCatalogBindings,
  pickBySegments,
  valueToText,
  collectMutationEffects,
  collectEmitDeclarations,
} from './browser/catalog-probes.js';
export type { TransitionLike, TraitListenerLike, CatalogBinding, MutationEffect, EmitDeclaration, EntityFieldLike } from './browser/catalog-probes.js';

// Re-export core algorithms
export {
  buildStateGraph,
  collectReachableStates,
  walkStatePairs,
  buildGuardPayloads,
  extractPayloadFieldRef,
  buildReplayPaths,
  buildEdgeCoveringWalk,
} from '@almadar/core';
