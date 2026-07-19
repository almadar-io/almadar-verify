/**
 * `TraitWalkConfig` — the per-trait input shape the kernel walks.
 *
 * Lives here for historical reasons (it predates the planner/driver
 * split). New consumers should import from this path; future cleanup
 * may relocate to `planner/types.ts` once no external dependencies
 * remain on `@almadar-io/verify/engine`.
 *
 * The legacy `StateWalkEngine` class, `EngineAdapter` interface,
 * `EngineConfig`, and `WalkResult` types were removed in v2.0.0 along
 * with the back-compat shim path. Migrate to:
 *   - `runVerification` (from `pipeline/`) instead of `StateWalkEngine.walk()`
 *   - `Driver<Ctx>` (from `driver/`) instead of `EngineAdapter`
 *   - `ReportShape` + `coverage()` (from `observer/`) instead of `WalkResult`
 *
 * @packageDocumentation
 */

import type { EdgeWalkTransition, Event, TraitEventContract, TraitTick, WalkStep } from '@almadar/core';

/** Configuration for a single trait's walk. */
export interface TraitWalkConfig {
  traitName: string;
  initialState: string;
  transitions: EdgeWalkTransition[];
  /** Route path for this trait's page (e.g., "products", "orders"). */
  route?: string;
  /**
   * The event declarations from `trait.stateMachine.events`. Carries
   * each event's `payloadSchema` so planners can synthesize the
   * `success`-variant payload per transition (looking up the event by
   * `transition.event` key). Optional for backward compat with callers
   * that build `TraitWalkConfig` by hand; `extractTraitWalkConfigs`
   * always populates it.
   */
  events?: ReadonlyArray<Event>;
  /**
   * The trait's `linkedEntity` field. Threaded so payload synthesis
   * can resolve entity-typed fields (e.g. `data: ListItem`) using the
   * orbital's entity field defs.
   */
  linkedEntity?: string;
  /**
   * Events fired by the trait's *effects* (an `emit: { success, failure }`
   * options object on a `fetch`/`persist`/… effect), not by a user
   * affordance. `planWalk` uses these to compute each transition's
   * transient closure: a state whose entry effect emits one of these
   * auto-advances to the emit target, so a transition INTO it can settle
   * past it. Populated by `extractTraitWalkConfigs`.
   */
  effectEmittedEvents?: ReadonlySet<string>;
  /**
   * The trait's declared `ticks {}` rules. `planTickTests` turns each
   * numeric-interval tick into a wait-and-observe walk step so
   * tick-driven traits get real coverage. Populated by
   * `extractTraitWalkConfigs`.
   */
  ticks?: ReadonlyArray<TraitTick>;
  /**
   * The trait's declared `emits {}` event contracts (internal AND
   * external scope). The emit sweep fires each contract-declared event
   * through the bus once so downstream listeners get covered. Populated
   * by `extractTraitWalkConfigs`.
   */
  emitContracts?: ReadonlyArray<TraitEventContract>;
}

export type { WalkStep, EdgeWalkTransition };
