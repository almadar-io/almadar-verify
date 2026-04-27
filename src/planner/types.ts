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
export type TestKind =
  | 'interaction'
  | 'data-mutation'
  | 'contract'
  | 'click-path'
  | 'crud-create'
  | 'crud-edit'
  | 'crud-delete';

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
   * v3.2.0: success-emit event key extracted from the persist / fetch /
   * call-service / ref effect's `{ emit: { success: "X" } }` block.
   * `assertDataMutation` uses this as the canonical signal that the
   * effect ran successfully — checks
   * `frame.serverResponse.emittedEvents.includes(this)`. Independent
   * from `expectedRowDelta` so mock-backend acks that don't update the
   * store still pass the gate.
   */
  expectedSuccessEvent?: string;

  /**
   * v3.2.3: when an interaction-test step opens a form (e.g. a modal
   * containing a form-section), this is the form's `submitEvent` — the
   * event key dispatched when the user clicks the Save button. The
   * driver targets `[data-testid="action-<submitEvent>"]` to find and
   * click it. Extracted by the planner from the form-section's render-ui
   * config. No fallback heuristics — if the rendered button doesn't
   * carry the attribute, that's a UI bug to fix at source.
   */
  submitEvent?: string;

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

  // ── v3.7.0 CRUD-flow declarative fields (optional, populated by
  //     planUserCrudFlow) ───────────────────────────────────────────────

  /**
   * v3.7.0: form payload the observer expects to find on the row that
   * was added (`crud-create`) or mutated (`crud-edit`). Each key is a
   * field name on the linked entity; each value is the core
   * `FieldValue` the form was submitted with. `assertCrudFlow` asserts
   * the row's after-state matches every key/value pair.
   */
  expectedRowContent?: Record<string, FieldValue>;

  /**
   * v3.7.0: for `crud-edit`, the field names the observer expects to
   * appear in `EntityRowChange.fieldsChanged`. Lets the observer
   * distinguish "row changed in the right way" from "row changed in
   * some unrelated way".
   */
  expectedRowChangedFields?: ReadonlyArray<string>;

  /**
   * v3.7.0: for `crud-edit` / `crud-delete`, the row id this step
   * targets. The DOM trigger uses
   * `[data-testid="action-<event>"][data-row-id="<id>"]` to find the
   * specific affordance on that row. Single deterministic tag per row.
   * When undefined for a crud-edit/delete step, the trigger picks the
   * first `[data-row-id]` affordance in the rendered list (deterministic
   * structural position — not a heuristic).
   */
  targetRowId?: string;

  /**
   * v3.7.0: for `crud-delete`, the affordance event the driver clicks
   * AFTER the initial open click to actually fire the persist. This is
   * the confirmation modal's CONFIRM affordance (e.g. `CONFIRM_DELETE`).
   * For `crud-create` / `crud-edit` use `submitEvent` instead.
   */
  confirmEvent?: string;
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
