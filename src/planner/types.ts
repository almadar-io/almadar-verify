/**
 * Planner type contracts.
 *
 * Planners are pure functions that turn an `.orb`-derived trait shape
 * (transitions + initial state + emit declarations) into an ordered
 * list of `ExtendedWalkStep`s. The driver then executes those steps
 * one-by-one via `tick()`, producing a `Frame[]` stream.
 *
 * @packageDocumentation
 */

import type { WalkStep } from '@almadar/core';
import type { TriggerKind } from '../frame/types.js';
import type { TraitWalkConfig } from '../engine/types.js';
import type { EmitDeclaration } from '../browser/catalog-probes.js';

/**
 * `WalkStep` decorated with the kernel-level metadata observers and the
 * driver need:
 *   - `triggerKind`: how this step gets fired (bus, dom, auto-init, replay)
 *   - `coverageKey`: the same key `frame/keyOf(cause)` produces, computed
 *     up front so coverage's denominator never has to re-derive it
 */
export interface ExtendedWalkStep extends WalkStep {
  triggerKind: TriggerKind;
  /** Stable `${trait}:${from}+${event}->${to}${guardSuffix}`. Single source of truth for coverage. */
  coverageKey: string;
  /** The trait this step targets (carried so the kernel can route the step). */
  traitName: string;
}

/**
 * Input to `planWalk`. The trait's transitions + initialState are the
 * only required state-machine inputs; flags toggle the synthetic INIT
 * credit (default on) and the emit-sweep extension (default off — emit
 * sweep is a separate `planEmitSweep` call so callers can run it
 * independently).
 */
export interface PlanWalkInput {
  trait: TraitWalkConfig;
  /** Whether to prepend the synthetic auto-init step. Default: `true`. */
  includeAutoInit?: boolean;
}

/** Input to `planEmitSweep`. */
export interface PlanEmitInput {
  trait: TraitWalkConfig;
  /** Emit declarations collected from the trait's effects. */
  emits: ReadonlyArray<EmitDeclaration>;
}

/** Input to `planReplayTo`. */
export interface PlanReplayInput {
  trait: TraitWalkConfig;
  targetState: string;
}
