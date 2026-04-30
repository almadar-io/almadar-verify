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
    cascade?: Verdict;
    mutation?: Verdict;
    portal?: Verdict;
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
  };
  /** Aggregate pass/fail/warning counts in core's canonical shape. */
  summary: VerificationSummary;
  errors: ReadonlyArray<string>;
  warnings: ReadonlyArray<string>;
}

/** Re-export `EntityRow` so observer files don't need to dance through frame/types. */
export type { EntityRow };
