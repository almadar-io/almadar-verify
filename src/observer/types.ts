/**
 * Observer type contracts.
 *
 * Observers are pure functions that consume `Frame[]` chronologically
 * and produce typed verdicts, metrics, or reports. They never touch a
 * Playwright `Page`, never mutate state, never re-read the runtime —
 * everything an observer needs is precomputed by `tick()` into the
 * Frame stream.
 *
 * Each Frame carries its own per-step deltas (`consoleDelta`,
 * `eventLogDelta`, `entityChanges`), so observers don't need closure
 * state to compute "since the previous frame" diffs. The `Frame[]`
 * input is `ReadonlyArray` to make accidental mutation impossible.
 *
 * @packageDocumentation
 */

import type {
  EntityRow,
  FieldValue,
  VerificationSummary,
} from '@almadar/core';
import type { Frame, TriggerKind } from '../frame/types.js';
import type { EntityFieldLike } from '../browser/catalog-probes.js';

/** A pure consumer of the temporal frame stream. */
export type Observer<T> = (frames: ReadonlyArray<Frame>) => T;

/**
 * Coverage metric — produced by `coverage(frames, plan, …)`.
 *
 * When the caller supplies `schemaTransitionKeys`, the headline numbers
 * are schema-reconciled: numerator = declared transitions (+ planned
 * tick steps) observed at least once; denominator = declared transitions
 * + planned tick steps. A transition counts covered when ANY of its
 * planned variants (success/malformed/guard-fail) executed. Without
 * schema keys (hand-built callers), falls back to the legacy plan-key
 * accounting: numerator = deduped `frames.map(f => keyOf(f.cause))`
 * intersected with the plan's keys; denominator = plan keys.
 */
export interface CoverageMetric {
  totalItems: number;
  coveredItems: number;
  ratio: number;
  /**
   * Total number of transitions declared across every inline trait's
   * state machine in the orbital schema — the SCHEMA denominator,
   * independent of what the planner chose to walk. Consumers gate on
   * `coveredItems / schemaTransitions` to catch plans that under-cover
   * the actual topology (a plan can be 100% of its own keys while
   * exercising only a fraction of the schema's transitions). `0` when
   * the caller didn't supply the schema count.
   */
  schemaTransitions: number;
  uncovered: ReadonlyArray<string>;
  /**
   * The covered coverage bases — the exact keys behind `coveredItems`
   * (schema-reconciled bases + tick keys when schema keys were
   * supplied; plan keys otherwise). Consumers aggregating coverage
   * across items use THIS list, never a re-derivation from frames —
   * frame-derived keys include extension steps outside the headline
   * denominator and would inflate the numerator.
   */
  coveredKeys: ReadonlyArray<string>;
  perTrait: Record<string, {
    total: number;
    covered: number;
    uncoveredKeys: ReadonlyArray<string>;
  }>;
  perTriggerKind: Record<TriggerKind, { total: number; covered: number }>;
}

/** Match recorded by the binding probe — what the runtime/DOM rendered vs what the schema declared. */
export interface BindingMatch {
  slot: string;
  expected: string;
  actual: string;
}

/** Output of `probeBindings(frame, prev)`. */
export interface BindingDelta {
  matched: ReadonlyArray<BindingMatch>;
  missing: ReadonlyArray<{ slot: string; expected: string }>;
}

/** Rule fed to `assertCascade` — how many cascade events a transition should produce. */
export interface CascadeRule {
  traitName: string;
  event: string;
  /** Inclusive lower bound for cascade count. */
  minCascade: number;
  /** Inclusive upper bound for cascade count. Omitted means no upper bound. */
  maxCascade?: number;
}

/**
 * Per-transition portal expectation fed to `assertPortalPerStep`.
 * For each accepted, non-repositioning, non-guard-fail frame matching
 * `(traitName, from, event, to)`, the observer asserts the named slot
 * is mounted with `childCount > 0` (or absent if `pattern === null`,
 * meaning the transition explicitly clears that slot).
 *
 * Pre-v3.0.0 this lived as orbital's per-step `probePortalSlots` call
 * inside the legacy `EngineAdapter.onTransition`. Consumers compute
 * these from their schema (orbital's `portalRendersFromTransition`)
 * and hand them to the kernel via `RunVerificationInput.rules.portal`.
 */
export interface PortalExpectation {
  traitName: string;
  from: string;
  event: string;
  to: string;
  slot: string;
  /** Pattern name expected in the slot, or `null` to assert the slot is empty/unmounted. */
  pattern: string | null;
}

/**
 * Rule fed to `assertMutation` — replaces both VG11b/d (count delta)
 * AND VG11f (per-field content). When `requiredFields` is set, the
 * observer also asserts every required field on every added EntityRow
 * has a non-empty `FieldValue` (skipping framework-managed fields and
 * fields with a declared `default`).
 */
export interface MutationRule {
  entityName: string;
  /** +1 on create, -1 on delete, 0 on update. */
  expectedDelta: number;
  /** When set → field-content assertion fires on every added row. */
  requiredFields?: ReadonlyArray<EntityFieldLike>;
}

/** One field's content check (VG11f). */
export interface FieldContentCheck {
  field: string;
  present: boolean;
  /** Actual value observed on the row; typed as core's `FieldValue`. */
  value: FieldValue | undefined;
  detail: string;
}

/** Per-row outcome from the field-content sweep. */
export interface EntityRowContentVerdict {
  rowId: string;
  passed: boolean;
  checks: ReadonlyArray<FieldContentCheck>;
  detail: string;
}

/** A single observer's verdict. */
export interface Verdict {
  passed: boolean;
  detail: string;
  evidence?: {
    frameIndices: ReadonlyArray<number>;
    /** Populated by `assertMutation` when `requiredFields` was provided. */
    rowsInspected?: ReadonlyArray<EntityRowContentVerdict>;
  };
}

/** Output of `report(frames, plan, options)`. */
export interface ReportShape {
  generatedAt: string;
  itemName: string;
  frames: ReadonlyArray<Frame>;
  coverage: CoverageMetric;
  verdicts: {
    /**
     * End-of-walk blank-portal sweep (`assertPortalSlots`): no slot is
     * left mounted-but-empty after the walk. Kept distinct from
     * `portalPerStep` so neither assignment clobbers the other.
     */
    portalSweep?: Verdict;
    /**
     * Per-transition portal expectations (`assertPortalPerStep`): each
     * render-ui transition mounts its declared slot with content.
     */
    portalPerStep?: Verdict;
    binding?: Verdict;
    refTrait?: Verdict;
    /** VG3 — one verdict per click-path sample, combined. */
    clickPath?: Verdict;
    /** Phase 4c — one verdict per contract emit, combined. */
    contract?: Verdict;
    /** Phase 4b+ — one verdict per data-mutation test, combined. */
    dataMutation?: Verdict;
    /** Phase 4b — one verdict per interaction test, combined. */
    interaction?: Verdict;
    /** v3.7.0 — one verdict per CRUD-flow test (create/edit/delete), combined. */
    crud?: Verdict;
    /**
     * Gap #13 — cross-orbital trait isolation. Fails when a dispatch from
     * trait T in orbital A drives any trait outside A without a declared
     * cross-orbital `listens` channel. Defense-in-depth alongside the
     * `.lolo` parser and orb-validator integrity passes.
     */
    orbitalIsolation?: Verdict;
    /**
     * Gap #0 — bus:click-no-listener. Fails when a DOM click emits a bus
     * event with zero matching trait subscribers (neither self-targeting
     * transition nor cross-trait `listens` cascade).
     */
    clickNoListener?: Verdict;
    /**
     * REPLAY-NONDET-DISPATCH — fails when a hermetic-preamble reconcile
     * hop lands in a different state than the replay plan projected. The
     * preamble BFS assumes one target per `(from, event)`, but a guarded
     * transition branches; if the runtime takes the other branch the
     * remaining preamble is aborted and this verdict names the divergent
     * hop, so the step's stale precondition can't silently corrupt later
     * verdicts.
     */
    replayDiverged?: Verdict;
    /**
     * GUARD-LAMBDA-DROP — `assertGuardParity` divergence. Fails when a
     * frame's planner-predicted `cause.guardCase` (`'pass'` / `'fail'`)
     * disagrees with the runtime's actual `accepted` verdict, the
     * fingerprint of a guard lambda dropped between planner and runtime.
     */
    guardParity?: Verdict;
    /**
     * PRECONDITION-UNREACHABLE — informational (`passed: true`). Names
     * every step whose `from` precondition couldn't be established (no
     * replay path found, or the replay diverged) and was skipped instead
     * of firing from a stale state. The transition still shows up as
     * uncovered in `coverage`; this records why.
     */
    preconditionSkipped?: Verdict;
  };
  /** Aggregate pass/fail/warning counts in core's canonical shape. */
  summary: VerificationSummary;
  errors: ReadonlyArray<string>;
  warnings: ReadonlyArray<string>;
  /**
   * Present only when the run used `walkScope: 'frontier'`. Explicit
   * accounting for the imported-trait topology the frontier scope did
   * NOT walk — those state machines are fixed by their source atoms and
   * verified in the atom's own package corpus; skipping them here is a
   * scope decision, never silent truncation. `coverage` denominators are
   * already scoped to the walked traits when this block is present.
   */
  frontier?: FrontierSummary;
  /**
   * Present only when one or more traits' walk stopped early because a
   * budget (`maxWalkMs`/`maxFrames`) was exceeded, NOT because the plan
   * ran out of steps. Distinguishes "truncated run" from "authoring bug":
   * `coverage.uncovered` reports the same transitions as bare
   * `uncovered transition: …` warnings either way, but this field is the
   * only place that says WHY — a budget-exceeded truncation the caller
   * should widen the budget for, vs. a genuinely unreachable/dead
   * transition worth fixing in the schema.
   */
  walkBudget?: ReadonlyArray<WalkBudgetEntry>;
}

/** One trait's walk truncated by a budget, attached to `ReportShape.walkBudget`. */
export interface WalkBudgetEntry {
  traitName: string;
  /** Which budget stopped the walk. */
  reason: 'maxWalkMs' | 'maxFrames';
  /** Plan steps actually executed before the budget stopped the walk. */
  stepsCompleted: number;
  /** Total steps the plan would have executed had the budget not stopped it. */
  totalSteps: number;
  /** Wall-clock time spent on this trait's walk when the budget fired. */
  elapsedMs: number;
  /** The configured `maxWalkMs` in effect for this run. */
  maxWalkMs: number;
  /** Plan steps left un-executed — an upper bound on transitions this
   *  truncation could account for (some may be covered by other steps). */
  stepsUnreached: number;
}

/** Frontier-scope accounting attached to `ReportShape.frontier`. */
export interface FrontierSummary {
  /** Traits authored directly on the orbital — walked in full. */
  authoredTraits: number;
  /** Traits cloned from `uses[]` imports — base topology skipped. */
  importedTraits: number;
  /** Total transitions across the skipped imported topologies. */
  importedTransitionsSkipped: number;
  /** Per-trait record of what was skipped and where it IS verified. */
  skipped: ReadonlyArray<{
    /** Call-site trait name on the orbital. */
    trait: string;
    /** Source behavior (`sourceBehavior.behavior`) that owns the topology. */
    source: string;
    /** Number of transitions in the skipped topology. */
    transitions: number;
  }>;
}

/** Re-export `EntityRow` so observer files don't need to dance through frame/types. */
export type { EntityRow };
