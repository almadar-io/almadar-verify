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
 * Server-emit cascade credit: in addition to crediting keys via
 * `keyOf(frame.cause)` (transitions the walker explicitly dispatched),
 * the observer also credits planned keys whose transitions fired on the
 * server cascade — events like `XLoaded` from a fetch's `emit.success`
 * that have no DOM affordance for the walker to dispatch directly but
 * land as observable transitions inside some other frame's
 * `runtimeSnapshot.transitions[]`. Without this, the canonical
 * `loading + XLoaded -> browsing[success]` edge stays uncovered on
 * every fetch-driven atom even though it demonstrably ran. Matched
 * against `planKeys` so we never over-credit unplanned transitions.
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
  schemaTransitions = 0,
): CoverageMetric {
  // Denominator: every key the plan declared.
  const planKeys = new Set<string>();
  for (const step of plan) {
    planKeys.add(step.coverageKey);
  }

  // Numerator (1/2): every coverage key the kernel observed via a
  // frame whose cause IS that transition.
  const coveredSet = new Set<string>();
  for (const frame of frames) {
    coveredSet.add(keyOf(frame.cause));
  }

  // Numerator (2/2): server-emit cascade credit. Walk every observed
  // transition across all frames' runtime snapshots. Build candidate
  // keys in the same shape planWalk emits (base + [success] variant for
  // unguarded transitions), and credit any that matches a planned key.
  // Guard / malformed / guard-fail variants are intentionally NOT
  // credited this way — those test the validator's reject paths and a
  // healthy cascade observation says nothing about them.
  for (const frame of frames) {
    for (const tx of frame.runtimeSnapshot.transitions) {
      const base = `${tx.traitName}:${tx.from}+${tx.event}->${tx.to}`;
      if (planKeys.has(base)) coveredSet.add(base);
      const withSuccess = `${base}[success]`;
      if (planKeys.has(withSuccess)) coveredSet.add(withSuccess);
    }
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
    schemaTransitions,
    uncovered,
    perTrait,
    perTriggerKind,
  };
}
