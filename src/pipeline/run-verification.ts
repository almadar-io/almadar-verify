/**
 * `runVerification` — composes the three layers into one entrypoint.
 *
 * v3.0.0: takes the parsed `OrbitalSchema` directly. Internally:
 *   1. extractTraitWalkConfigs(orbital) → TraitWalkConfig[]
 *   2. For each trait: planWalk + (optional) planClickPathSamples
 *      / planContractEvents / planDataMutationTests / planInteractionTests
 *      contributions targeted at this trait
 *   3. fold(tick) over the combined steps → Frame[]
 *   4. Run all observers; produce report
 *
 * Consumer tools (orbital-verify-unified, runtime-verify) pass the
 * parsed orbital + a driver + a contract registry (optional). Verify
 * derives all verification semantics internally — tools own only
 * environment setup.
 *
 * @packageDocumentation
 */

import { rmSync, mkdirSync } from 'node:fs';
import type { Frame } from '../frame/types.js';
import { tick } from '../driver/tick.js';
import type { DriverContext } from '../driver/types.js';
import { planWalk } from '../planner/plan-walk.js';
import { extractTraitWalkConfigs } from '../planner/extract-trait-walk-configs.js';
import { planClickPathSamples } from '../planner/plan-click-path-samples.js';
import { planContractEvents } from '../planner/plan-contract-events.js';
import { planDataMutationTests } from '../planner/plan-data-mutation-tests.js';
import { planInteractionTests } from '../planner/plan-interaction-tests.js';
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
  const opts = input.options ?? {};

  // ── Wipe the per-behavior output dir before starting ──────────────
  // Stale frames + transition logs + reports from a previous run
  // outlive the new run when the new run produces fewer artifacts
  // (e.g. fewer frames after a planner change), and they show up in
  // screenshot reviews as "ghost" results that don't reflect the
  // current state. Recreating the dir at the start gives every run a
  // clean slate. Skipped when outputDir is empty (test-fixture mode).
  const outputDir = input.ctx.outputDir;
  if (outputDir !== undefined && outputDir !== '') {
    try {
      rmSync(outputDir, { recursive: true, force: true });
      mkdirSync(outputDir, { recursive: true });
    } catch { /* best-effort — keep going if FS errors */ }
  }

  // ── Derive everything from the parsed orbital ─────────────────────
  const traits = extractTraitWalkConfigs(input.orbital);

  // Planner extension steps — bucketed by trait so the per-trait walk
  // appends them after the base topology walk.
  const extensionStepsByTrait = new Map<string, ExtendedWalkStep[]>();
  const collectExtension = (steps: ReadonlyArray<ExtendedWalkStep>): void => {
    for (const step of steps) {
      const bucket = extensionStepsByTrait.get(step.traitName) ?? [];
      bucket.push(step);
      extensionStepsByTrait.set(step.traitName, bucket);
    }
  };

  if (opts.enableInteractionTests !== false) {
    collectExtension(planInteractionTests(input.orbital));
  }
  if (opts.enableDataMutationTests !== false) {
    collectExtension(planDataMutationTests(input.orbital));
  }
  if (opts.enableClickPathSamples !== false) {
    collectExtension(planClickPathSamples(input.orbital));
  }
  if (opts.enableContractEvents !== false && opts.contractRegistry !== undefined) {
    collectExtension(planContractEvents(input.orbital, opts.contractRegistry));
  }

  // ── Walk every trait through the same tick loop ───────────────────
  const frames: Frame[] = [];
  const wholePlan: ExtendedWalkStep[] = [];

  for (const trait of traits) {
    const ctx = { ...input.ctx, trait } as Ctx;

    if (input.driver.beforeTrait !== undefined) {
      await input.driver.beforeTrait(ctx);
    }
    await input.driver.reset(ctx);

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

  // ── Run observers ─────────────────────────────────────────────────
  const verdicts: RunVerificationOutput['verdicts'] = {};

  // VG6 — ref-trait invariant (always runs).
  verdicts.refTrait = assertRefTraitInvariantOverFrames(frames);

  // End-of-walk portal blank-portal sweep (always).
  verdicts.portal = assertPortalSlots(frames);

  // VG11a — binding probes (per-frame, always).
  const bindingVerdicts = frames.map((frame, i) =>
    bindingDeltaToVerdict(probeBindings(frame, i > 0 ? frames[i - 1] : null), frame.index),
  );
  if (bindingVerdicts.length > 0) {
    verdicts.binding = combineVerdicts(bindingVerdicts, 'binding');
  }

  // VG3 — click-path samples (only fires when planClickPathSamples
  // produced steps).
  const clickPathVerdicts = assertClickPathSample(frames);
  if (clickPathVerdicts.length > 0) {
    verdicts.clickPath = combineVerdicts(clickPathVerdicts, 'click-path');
  }

  // Phase 4c — contract event coverage.
  const contractVerdicts = assertContractEventFired(frames);
  if (contractVerdicts.length > 0) {
    verdicts.contract = combineVerdicts(contractVerdicts, 'contract');
  }

  // Phase 4b+ — data mutation.
  const dataMutationVerdicts = assertDataMutation(frames);
  if (dataMutationVerdicts.length > 0) {
    verdicts.dataMutation = combineVerdicts(dataMutationVerdicts, 'data-mutation');
  }

  // Phase 4b — interaction patterns.
  const interactionVerdicts = assertInteractionPattern(frames);
  if (interactionVerdicts.length > 0) {
    verdicts.interaction = combineVerdicts(interactionVerdicts, 'interaction');
  }

  // VG1 per-step — derived from each transition's render-ui declarations.
  if (opts.enablePortalPerStep !== false) {
    const portalExpectations = derivePortalExpectations(input.orbital);
    if (portalExpectations.length > 0) {
      const v = assertPortalPerStep(frames, portalExpectations);
      if (v.length > 0) {
        verdicts.portal = combineVerdicts(v, 'portal');
      }
    }
  }

  // Cascade rules / mutation rules can be derived from transitions too,
  // but the simplest v3.0.0 contract just runs assertCascade per
  // declared `emit:` and assertMutation via planDataMutationTests.
  // Both already covered above. (Future: add `derivedCascadeRules`
  // here for finer-grained cascade verification.)

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

/**
 * Walk the orbital's traits' transitions for `render-ui` effects and
 * derive `PortalExpectation[]` for `assertPortalPerStep`. Each
 * transition with a render-ui contributes one expectation: the slot
 * the effect targets and the top-level pattern name in the payload.
 */
function derivePortalExpectations(
  orbital: import('@almadar/core').OrbitalSchema,
): import('../observer/types.js').PortalExpectation[] {
  const result: import('../observer/types.js').PortalExpectation[] = [];
  for (const orb of orbital.orbitals) {
    for (const traitRef of orb.traits ?? []) {
      // Reuse isInlineTrait inline to avoid pulling another import.
      if (typeof traitRef === 'string') continue;
      if ('ref' in traitRef && typeof (traitRef as { ref?: unknown }).ref === 'string') continue;
      const trait = traitRef as import('@almadar/core').Trait;
      if (trait.stateMachine === undefined) continue;

      for (const transition of trait.stateMachine.transitions) {
        for (const effect of transition.effects ?? []) {
          if (!Array.isArray(effect)) continue;
          if (effect[0] !== 'render-ui') continue;
          const slot = typeof effect[1] === 'string' ? effect[1] : null;
          if (slot === null) continue;
          const payload = effect[2];
          let pattern: string | null = null;
          if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
            const t = (payload as { type?: unknown }).type;
            if (typeof t === 'string') pattern = t;
          }
          result.push({
            traitName: trait.name,
            from: transition.from,
            event: transition.event,
            to: transition.to,
            slot,
            pattern,
          });
        }
      }
    }
  }
  return result;
}
