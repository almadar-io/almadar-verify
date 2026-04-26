/**
 * `runVerification` — composes the three layers into one entrypoint.
 *
 * Flow:
 *   for each trait:
 *     beforeTrait()
 *     reset()
 *     plan = planWalk(trait)
 *     for step in plan: frames.push(await tick(driver, ctx, prev, step))
 *   coverage = coverage(frames, plan)
 *   verdicts = { cascade, mutation, portal, binding, refTrait }
 *   return report(...)
 *
 * Generic over `Ctx` so consumer transports flow through end-to-end.
 *
 * @packageDocumentation
 */

import type { Frame } from '../frame/types.js';
import { tick } from '../driver/tick.js';
import type { DriverContext } from '../driver/types.js';
import { planWalk } from '../planner/plan-walk.js';
import type { ExtendedWalkStep } from '../planner/types.js';
import { assertCascade } from '../observer/assert-cascade.js';
import { assertMutation } from '../observer/assert-mutation.js';
import { assertPortalSlots } from '../observer/assert-portal.js';
import { assertRefTraitInvariantOverFrames } from '../observer/assert-ref-trait-invariant.js';
import { probeBindings } from '../observer/probe-bindings.js';
import { report } from '../observer/report.js';
import type { Verdict } from '../observer/types.js';
import type { RunVerificationInput, RunVerificationOutput } from './types.js';

const DEFAULT_MAX_WALK_MS = 60_000;
const DEFAULT_MAX_FRAMES = 5_000;

export async function runVerification<Ctx extends DriverContext>(
  input: RunVerificationInput<Ctx>,
): Promise<RunVerificationOutput> {
  const log = input.options?.log ?? ((m: string) => process.stdout.write(m + '\n'));
  const maxWalkMs = input.options?.maxWalkMs ?? DEFAULT_MAX_WALK_MS;
  const maxFrames = input.options?.maxFrames ?? DEFAULT_MAX_FRAMES;

  const frames: Frame[] = [];
  const wholePlan: ExtendedWalkStep[] = [];

  for (const trait of input.traits) {
    const ctx = { ...input.ctx, trait } as Ctx;

    // Per-trait setup hook.
    if (input.driver.beforeTrait !== undefined) {
      await input.driver.beforeTrait(ctx);
    }

    // Reset to clean state.
    await input.driver.reset(ctx);

    // Build the plan for this trait.
    const plan = planWalk({ trait });
    wholePlan.push(...plan);

    log(`[runVerification] ${trait.traitName}: ${plan.length} steps`);

    const traitStart = Date.now();
    let prev: Frame | null = null;
    let stepIdx = 0;
    for (const step of plan) {
      if (frames.length >= maxFrames) {
        log(`[runVerification] ${trait.traitName}: maxFrames (${maxFrames}) reached`);
        break;
      }
      if (Date.now() - traitStart > maxWalkMs) {
        log(`[runVerification] ${trait.traitName}: maxWalkMs (${maxWalkMs}) exceeded at step ${stepIdx}/${plan.length}`);
        break;
      }
      const frame: Frame = await tick(input.driver, ctx, prev, step);
      frames.push(frame);
      const status = frame.accepted ? 'OK' : 'REJECTED';
      log(`  [${stepIdx + 1}/${plan.length}] ${step.from} --${step.event}--> ${step.to} | ${status}`);
      prev = frame;
      stepIdx += 1;
    }
  }

  // Run observers.
  const verdicts: RunVerificationOutput['verdicts'] = {};

  if (input.rules?.cascade !== undefined && input.rules.cascade.length > 0) {
    const verdict = combineVerdicts(
      input.rules.cascade.map((rule) => assertCascade(frames, rule)),
      'cascade',
    );
    verdicts.cascade = verdict;
  }

  if (input.rules?.mutation !== undefined && input.rules.mutation.length > 0) {
    const allVerdicts: Verdict[] = [];
    for (const rule of input.rules.mutation) {
      for (let i = 1; i < frames.length; i++) {
        allVerdicts.push(assertMutation(frames[i], frames[i - 1], rule));
      }
    }
    if (allVerdicts.length > 0) {
      verdicts.mutation = combineVerdicts(allVerdicts, 'mutation');
    }
  }

  verdicts.portal = assertPortalSlots(frames);
  verdicts.refTrait = assertRefTraitInvariantOverFrames(frames);

  // probeBindings is per-frame; combine into a single binding verdict.
  const bindingVerdicts = frames.map((frame, i) =>
    bindingDeltaToVerdict(probeBindings(frame, i > 0 ? frames[i - 1] : null), frame.index),
  );
  if (bindingVerdicts.length > 0) {
    verdicts.binding = combineVerdicts(bindingVerdicts, 'binding');
  }

  return report({
    itemName: input.itemName,
    frames,
    plan: wholePlan,
    verdicts,
  });
}

// ── internal ─────────────────────────────────────────────────────────

function combineVerdicts(verdicts: ReadonlyArray<Verdict>, label: string): Verdict {
  const failed = verdicts.filter((v) => !v.passed);
  if (failed.length === 0) {
    return {
      passed: true,
      detail: `${label}: ${verdicts.length} check(s) passed`,
      evidence: { frameIndices: collectFrameIndices(verdicts) },
    };
  }
  return {
    passed: false,
    detail: `${label}: ${failed.length}/${verdicts.length} failed — ${failed[0].detail}`,
    evidence: { frameIndices: collectFrameIndices(verdicts) },
  };
}

function collectFrameIndices(verdicts: ReadonlyArray<Verdict>): ReadonlyArray<number> {
  const out = new Set<number>();
  for (const v of verdicts) {
    for (const i of v.evidence?.frameIndices ?? []) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

function bindingDeltaToVerdict(
  delta: { matched: ReadonlyArray<unknown>; missing: ReadonlyArray<{ slot: string; expected: string }> },
  frameIndex: number,
): Verdict {
  if (delta.missing.length === 0) {
    return {
      passed: true,
      detail: `binding: ${delta.matched.length} match(es) on frame ${frameIndex}`,
      evidence: { frameIndices: [frameIndex] },
    };
  }
  return {
    passed: false,
    detail: `binding: ${delta.missing.length} missing on frame ${frameIndex} — ${delta.missing.map((m) => m.slot).join(', ')}`,
    evidence: { frameIndices: [frameIndex] },
  };
}
