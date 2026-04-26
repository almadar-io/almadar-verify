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
import { assertClickPathSample } from '../observer/assert-click-path-sample.js';
import { assertContractEventFired } from '../observer/assert-contract-event-fired.js';
import { assertDataMutation } from '../observer/assert-data-mutation.js';
import { assertPortalPerStep } from '../observer/assert-portal-per-step.js';
import { assertInteractionPattern } from '../observer/assert-interaction-pattern.js';
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

  // Run planner extensions ONCE up front (each receives the full trait
  // list and returns extra steps). Group them by traitName so the
  // per-trait walk loop appends them after the base walk for that trait.
  const extensionStepsByTrait = new Map<string, ExtendedWalkStep[]>();
  for (const extension of input.planExtensions ?? []) {
    const steps = extension(input.traits);
    for (const step of steps) {
      const bucket = extensionStepsByTrait.get(step.traitName) ?? [];
      bucket.push(step);
      extensionStepsByTrait.set(step.traitName, bucket);
    }
  }

  for (const trait of input.traits) {
    const ctx = { ...input.ctx, trait } as Ctx;

    // Per-trait setup hook.
    if (input.driver.beforeTrait !== undefined) {
      await input.driver.beforeTrait(ctx);
    }

    // Reset to clean state.
    await input.driver.reset(ctx);

    // Build the plan for this trait: base walk steps + any extension
    // steps targeted at this trait.
    const baseSteps = planWalk({ trait });
    const extensionSteps = extensionStepsByTrait.get(trait.traitName) ?? [];
    const plan = [...baseSteps, ...extensionSteps];
    wholePlan.push(...plan);

    log(
      `[runVerification] ${trait.traitName}: ${plan.length} steps (${baseSteps.length} base + ${extensionSteps.length} extension)`,
    );

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

  // VG3 — click-path samples. assertClickPathSample emits one verdict
  // per frame whose cause.testKind === 'click-path'; combine into a
  // single verdict for the report. Skipped entirely if no click-path
  // frames exist (planClickPathSamples wasn't passed as an extension).
  const clickPathVerdicts = assertClickPathSample(frames);
  if (clickPathVerdicts.length > 0) {
    verdicts.clickPath = combineVerdicts(clickPathVerdicts, 'click-path');
  }

  // Phase 4c — contract event coverage. One verdict per frame whose
  // cause.testKind === 'contract'; combine. Skipped if no contract
  // frames exist (planContractEvents wasn't passed as an extension).
  const contractVerdicts = assertContractEventFired(frames);
  if (contractVerdicts.length > 0) {
    verdicts.contract = combineVerdicts(contractVerdicts, 'contract');
  }

  // Phase 4b+ — data mutation verification. One verdict per frame
  // whose cause.testKind === 'data-mutation'; combine. Skipped if no
  // data-mutation frames exist (planDataMutationTests wasn't passed
  // as an extension). Reads cause.expectedRowDelta + frame.entityChanges.
  const dataMutationVerdicts = assertDataMutation(frames);
  if (dataMutationVerdicts.length > 0) {
    verdicts.dataMutation = combineVerdicts(dataMutationVerdicts, 'data-mutation');
  }

  // VG1 — per-step portal slot verification. assertPortalPerStep emits
  // one verdict per (frame × matched expectation); combine. The
  // existing assertPortalSlots (above) is the end-of-walk "blank
  // portal" sweep — this one fires per-step using rules.portal.
  if (input.rules?.portal !== undefined && input.rules.portal.length > 0) {
    const portalPerStepVerdicts = assertPortalPerStep(frames, input.rules.portal);
    if (portalPerStepVerdicts.length > 0) {
      // Merge into the existing portal verdict (overwrites the
      // end-of-walk one if both fired — the per-step is stricter).
      verdicts.portal = combineVerdicts(portalPerStepVerdicts, 'portal');
    }
  }

  // Phase 4b — interaction pattern verification. One verdict per
  // frame whose cause.testKind === 'interaction'. Reads
  // cause.expectedPattern + frame.domSnapshot.portals + the runtime
  // snapshot's currentState diff. Skipped if no interaction frames
  // exist (planInteractionTests wasn't passed as an extension).
  const interactionVerdicts = assertInteractionPattern(frames);
  if (interactionVerdicts.length > 0) {
    verdicts.interaction = combineVerdicts(interactionVerdicts, 'interaction');
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
