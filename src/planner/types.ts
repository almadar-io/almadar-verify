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

import type { FieldValue, ReplayStep, WalkStep } from '@almadar/core';
import type { TriggerKind } from '../frame/types.js';
import type { TraitWalkConfig } from '../engine/types.js';
import type { EmitDeclaration } from '../browser/catalog-probes.js';

/**
 * Tag used by observers to group verdicts produced by the v3.0.0
 * planner extensions. Steps emitted by the base `planWalk` /
 * `planInitCredit` / `planEmitSweep` / `planReplayTo` planners leave
 * this undefined.
 */
export type TestKind = 'interaction' | 'data-mutation' | 'contract' | 'click-path';

/**
 * Per-entity row-count delta the observer expects after a step
 * settles. Used by `assertDataMutation` for CRUD verification.
 */
export interface ExpectedRowDelta {
  entityName: string;
  /** Positive on create, negative on delete, zero on update. */
  delta: number;
}

/**
 * `WalkStep` decorated with the kernel-level metadata observers and the
 * driver need:
 *   - `triggerKind`: how this step gets fired (bus, dom, auto-init, replay)
 *   - `coverageKey`: the same key `frame/keyOf(cause)` produces, computed
 *     up front so coverage's denominator never has to re-derive it
 *   - v3.0.0 fields (all optional): declarative metadata the planners
 *     attach so observers and `Driver.triggerDOM` can do their work
 *     without re-reading the schema or re-querying the runtime.
 */
export interface ExtendedWalkStep extends WalkStep {
  triggerKind: TriggerKind;
  /** Stable `${trait}:${from}+${event}->${to}${guardSuffix}`. Single source of truth for coverage. */
  coverageKey: string;
  /** The trait this step targets (carried so the kernel can route the step). */
  traitName: string;

  // ── v3.0.0 declarative fields (optional, populated by the lifted planners) ──

  /**
   * When set together with `triggerKind === 'dom'`, `Driver.triggerDOM`
   * fills the form's matching fields with these values before clicking
   * submit. Keys are field names; values are core `FieldValue`s.
   */
  formData?: Record<string, FieldValue>;

  /**
   * Pattern observer expects to be mounted in the next frame's
   * `domSnapshot.portals` after this step settles. Used by
   * `assertInteractionPattern` to verify "did the modal open?" without
   * re-querying the DOM.
   */
  expectedPattern?: string;

  /**
   * Per-entity row-count delta observer expects after this step's
   * settle. Used by `assertDataMutation` for CRUD verification.
   */
  expectedRowDelta?: ExpectedRowDelta;

  /**
   * Steps to replay first to reach this step's `from` state. The
   * planner expands these inline so each becomes its own
   * `triggerKind: 'replay'` Frame in the kernel walk; consumers should
   * treat this field as advisory metadata, not as a directive `tick`
   * acts on directly. Pre-populated from `@almadar/core`'s `ReplayStep`.
   */
  replayPath?: ReadonlyArray<ReplayStep>;

  /**
   * Tag used by observers to group verdicts. Steps from the base
   * planners (planWalk, planInitCredit, planEmitSweep, planReplayTo)
   * leave this undefined; v3.0.0 planner extensions stamp it with the
   * matching kind.
   */
  testKind?: TestKind;
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
