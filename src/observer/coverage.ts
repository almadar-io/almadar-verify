/**
 * `coverage` — the unified coverage observer.
 *
 * Numerator: deduped `frames.map(f => keyOf(f.cause))` intersected with
 * the plan's keys. Denominator: every coverage key in the plan.
 *
 * Same source for numerator and denominator (the `ExtendedWalkStep[]`
 * the planner produced and the kernel actually executed) eliminates
 * the orbital-vs-runtime discrepancy at its root: there is no place
 * for the two consumer tools to diverge.
 *
 * Pure.
 *
 * @packageDocumentation
 */

import type { Frame, TriggerKind } from '../frame/types.js';
import { keyOf } from '../frame/factory.js';
import type { ExtendedWalkStep } from '../planner/types.js';
import type { CoverageMetric } from './types.js';

const TRIGGER_KINDS: ReadonlyArray<TriggerKind> = ['bus', 'dom', 'auto-init', 'replay'];

export function coverage(
  frames: ReadonlyArray<Frame>,
  plan: ReadonlyArray<ExtendedWalkStep>,
): CoverageMetric {
  // Numerator: every coverage key the kernel actually produced.
  const coveredSet = new Set<string>();
  for (const frame of frames) {
    coveredSet.add(keyOf(frame.cause));
  }

  // Denominator: every key the plan declared.
  const planKeys = new Set<string>();
  for (const step of plan) {
    planKeys.add(step.coverageKey);
  }

  // Intersection — only credit keys that were both planned and observed.
  const covered = new Set<string>();
  for (const key of coveredSet) {
    if (planKeys.has(key)) covered.add(key);
  }

  const totalItems = planKeys.size;
  const coveredItems = covered.size;
  const ratio = totalItems === 0 ? 0 : coveredItems / totalItems;

  // Per-trait breakdown.
  const perTrait: Record<string, {
    total: number;
    covered: number;
    uncoveredKeys: string[];
  }> = {};
  for (const step of plan) {
    const bucket = perTrait[step.traitName] ?? { total: 0, covered: 0, uncoveredKeys: [] };
    bucket.total += 1;
    if (covered.has(step.coverageKey)) {
      bucket.covered += 1;
    } else {
      bucket.uncoveredKeys.push(step.coverageKey);
    }
    perTrait[step.traitName] = bucket;
  }

  // Per-trigger-kind breakdown.
  const perTriggerKind = TRIGGER_KINDS.reduce(
    (acc, kind) => ({ ...acc, [kind]: { total: 0, covered: 0 } }),
    {} as Record<TriggerKind, { total: number; covered: number }>,
  );
  for (const step of plan) {
    perTriggerKind[step.triggerKind].total += 1;
    if (covered.has(step.coverageKey)) {
      perTriggerKind[step.triggerKind].covered += 1;
    }
  }

  // Uncovered list.
  const uncovered: string[] = [];
  for (const key of planKeys) {
    if (!covered.has(key)) uncovered.push(key);
  }

  return {
    totalItems,
    coveredItems,
    ratio,
    uncovered,
    perTrait,
    perTriggerKind,
  };
}
