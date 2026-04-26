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
 * Coverage metric — produced by `coverage(frames, plan)`.
 *
 * Numerator: deduped `frames.map(f => keyOf(f.cause))` intersected with
 * the plan's coverage keys. Denominator: every coverage key in the
 * plan. Same source for both, so orbital-verify and runtime-verify can
 * never disagree on the ratio for the same trait + plan.
 */
export interface CoverageMetric {
  totalItems: number;
  coveredItems: number;
  ratio: number;
  uncovered: ReadonlyArray<string>;
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
    cascade?: Verdict;
    mutation?: Verdict;
    portal?: Verdict;
    binding?: Verdict;
    refTrait?: Verdict;
  };
  /** Aggregate pass/fail/warning counts in core's canonical shape. */
  summary: VerificationSummary;
  errors: ReadonlyArray<string>;
  warnings: ReadonlyArray<string>;
}

/** Re-export `EntityRow` so observer files don't need to dance through frame/types. */
export type { EntityRow };
