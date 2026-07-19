/**
 * `coverage` — the unified coverage observer.
 *
 * Headline mode (schema-reconciled, when `schemaTransitionKeys` is
 * supplied — `runVerification` always does): numerator = schema
 * transitions (+ planned tick steps) with at least one observed planned
 * variant; denominator = schema transitions + planned tick steps. One
 * honest number — the plan's malformed/success/guard-fail fan-out
 * collapses onto the base transition, and `schemaTransitions` no longer
 * sits alongside as a second, incomparable count.
 *
 * Legacy mode (no schema keys — hand-built callers): numerator = deduped
 * `frames.map(f => keyOf(f.cause))` intersected with the plan's keys;
 * denominator = every coverage key in the plan.
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

const TRIGGER_KINDS: ReadonlyArray<TriggerKind> = ['bus', 'dom', 'auto-init', 'replay', 'reconcile', 'tick'];

/**
 * Strip the `[variant]` suffix from a coverage key, yielding the
 * schema-transition base `${trait}:${from}+${event}->${to}`. Keys with
 * no suffix (auto-init, tick keys like `trait:tick(name)`) are their
 * own base.
 */
function baseOf(key: string): string {
  const idx = key.indexOf('[');
  return idx === -1 ? key : key.slice(0, idx);
}

export function coverage(
  frames: ReadonlyArray<Frame>,
  plan: ReadonlyArray<ExtendedWalkStep>,
  schemaTransitions = 0,
  schemaTransitionKeys?: ReadonlyArray<string>,
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

  // Per-trigger-kind breakdown (execution view — counts every plan step,
  // including extension planners' auxiliary steps).
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

  // Schema-reconciled headline numbers: when the caller supplies the
  // schema's transition keys, the denominator is the SCHEMA (declared
  // transitions + planned tick steps), not the plan's variant fan-out
  // (malformed/success/guard-fail steps collapse onto their base
  // transition). A schema transition is covered when at least one of its
  // planned variants was observed; a tick step is covered when its own
  // key was observed. Extension steps (emit sweep, contract, crud, …)
  // are auxiliary tests — excluded from the headline number, still
  // visible in perTriggerKind.
  if (schemaTransitionKeys !== undefined && schemaTransitionKeys.length > 0) {
    return schemaReconciledCoverage(schemaTransitionKeys, plan, covered, perTriggerKind, schemaTransitions);
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

/**
 * Headline coverage against the schema denominator. See the call site in
 * `coverage()` for the contract. `covered` is the plan-key intersection
 * the main body already computed.
 */
function schemaReconciledCoverage(
  schemaTransitionKeys: ReadonlyArray<string>,
  plan: ReadonlyArray<ExtendedWalkStep>,
  covered: ReadonlySet<string>,
  perTriggerKind: Record<TriggerKind, { total: number; covered: number }>,
  schemaTransitions: number,
): CoverageMetric {
  const schemaKeys = new Set(schemaTransitionKeys);
  const tickKeys = new Set<string>();
  for (const step of plan) {
    if (step.triggerKind === 'tick') tickKeys.add(step.coverageKey);
  }

  const coveredBases = new Set<string>();
  for (const key of covered) coveredBases.add(baseOf(key));

  const coveredSchema = new Set<string>();
  for (const key of schemaKeys) {
    if (coveredBases.has(key)) coveredSchema.add(key);
  }
  const coveredTick = new Set<string>();
  for (const key of tickKeys) {
    if (covered.has(key)) coveredTick.add(key);
  }

  const totalItems = schemaKeys.size + tickKeys.size;
  const coveredItems = coveredSchema.size + coveredTick.size;
  const ratio = totalItems === 0 ? 0 : coveredItems / totalItems;

  const uncovered: string[] = [];
  const perTrait: Record<string, {
    total: number;
    covered: number;
    uncoveredKeys: string[];
  }> = {};
  const bucketFor = (key: string): { total: number; covered: number; uncoveredKeys: string[] } => {
    const traitName = key.slice(0, key.indexOf(':'));
    const bucket = perTrait[traitName] ?? { total: 0, covered: 0, uncoveredKeys: [] };
    perTrait[traitName] = bucket;
    return bucket;
  };
  for (const key of schemaKeys) {
    const bucket = bucketFor(key);
    bucket.total += 1;
    if (coveredSchema.has(key)) {
      bucket.covered += 1;
    } else {
      bucket.uncoveredKeys.push(key);
      uncovered.push(key);
    }
  }
  for (const key of tickKeys) {
    const bucket = bucketFor(key);
    bucket.total += 1;
    if (coveredTick.has(key)) {
      bucket.covered += 1;
    } else {
      bucket.uncoveredKeys.push(key);
      uncovered.push(key);
    }
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
