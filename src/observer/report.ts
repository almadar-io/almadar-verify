/**
 * `report` — pure observer that folds Frame[] + plan + verdicts into a
 * `ReportShape`. The composer (`runVerification` in Phase 1) calls this
 * after running coverage + each assertion observer.
 *
 * Computes the `VerificationSummary` from the verdicts plus per-Frame
 * error/warning counts. Doesn't write to disk — `writeJsonReport` /
 * `writeMarkdownReport` (existing in the report/ dir) handle that.
 *
 * @packageDocumentation
 */

import type { VerificationSummary } from '@almadar/core';
import type { Frame } from '../frame/types.js';
import type { ExtendedWalkStep } from '../planner/types.js';
import { coverage } from './coverage.js';
import type { ReportShape, Verdict } from './types.js';

export interface ReportInput {
  itemName: string;
  frames: ReadonlyArray<Frame>;
  plan: ReadonlyArray<ExtendedWalkStep>;
  verdicts: ReportShape['verdicts'];
  /**
   * Total transitions across the orbital's inline-trait state machines —
   * the schema-level coverage denominator. Forwarded to `coverage()`.
   * Default 0 (caller didn't supply the schema count).
   */
  schemaTransitions?: number;
  /**
   * The schema's transition coverage bases (`${trait}:${from}+${event}->${to}`)
   * — one per declared transition. When supplied, `coverage()` reports the
   * headline covered/total against the SCHEMA denominator (transitions +
   * planned tick steps) instead of the plan's variant fan-out.
   */
  schemaTransitionKeys?: ReadonlyArray<string>;
  /**
   * Frontier-scope accounting from a `walkScope: 'frontier'` run.
   * Forwarded verbatim onto `ReportShape.frontier`.
   */
  frontier?: ReportShape['frontier'];
}

export function report(input: ReportInput): ReportShape {
  const { itemName, frames, plan, verdicts } = input;

  const cov = coverage(frames, plan, input.schemaTransitions ?? 0, input.schemaTransitionKeys);

  const errors: string[] = [];
  const warnings: string[] = [];
  for (const frame of frames) {
    for (const e of frame.errors) errors.push(`frame ${frame.index}: ${e}`);
    for (const w of frame.warnings) warnings.push(`frame ${frame.index}: ${w}`);
  }

  const summary = buildSummary(verdicts, errors.length, warnings.length);

  return {
    generatedAt: new Date().toISOString(),
    itemName,
    frames,
    coverage: cov,
    verdicts,
    summary,
    errors,
    warnings,
    ...(input.frontier !== undefined && { frontier: input.frontier }),
  };
}

/**
 * Build a `VerificationSummary` from the verdicts + frame error/warning
 * tallies. Each verdict counts as one check; passed → passed++,
 * failed → failed++. Frame errors/warnings flow into warnings/passed
 * as supplementary counts but don't change the per-verdict pass/fail
 * tallies.
 */
function buildSummary(
  verdicts: ReportShape['verdicts'],
  errorCount: number,
  warningCount: number,
): VerificationSummary {
  let totalChecks = 0;
  let passed = 0;
  let failed = 0;

  for (const verdict of Object.values(verdicts)) {
    if (verdict === undefined) continue;
    totalChecks += 1;
    if ((verdict as Verdict).passed) passed += 1;
    else failed += 1;
  }

  return {
    totalChecks,
    passed,
    failed,
    warnings: warningCount,
    pending: 0,
  };
}
