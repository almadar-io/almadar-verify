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

// node:fs is loaded dynamically below so browser bundles don't pull it in.
import type { Frame } from '../frame/types.js';
import { tick } from '../driver/tick.js';
import type { DriverContext } from '../driver/types.js';
import { planWalk } from '../planner/plan-walk.js';
import { extractTraitWalkConfigs } from '../planner/extract-trait-walk-configs.js';
import { collectEntityFields } from '../planner/internal/payload-synth.js';
import { eachInlineTrait, findInitialState } from '../planner/internal/orbital-walk.js';
import { planClickPathSamples } from '../planner/plan-click-path-samples.js';
import { planContractEvents } from '../planner/plan-contract-events.js';
import { planDataMutationTests } from '../planner/plan-data-mutation-tests.js';
import { planInteractionTests } from '../planner/plan-interaction-tests.js';
import { planUserCrudFlow } from '../planner/plan-user-crud-flow.js';
import { planReplayTo } from '../planner/plan-replay-to.js';
import { planTickTests } from '../planner/plan-tick-tests.js';
import { planEmitSweep } from '../planner/plan-emit-sweep.js';
import type { EmitDeclaration } from '../browser/catalog-probes.js';
import type { ExtendedWalkStep } from '../planner/types.js';
import type { TraitWalkConfig } from '../engine/types.js';
import { assertGuardParity } from '../observer/assert-guard-parity.js';
import { assertPortalSlots } from '../observer/assert-portal.js';
import { assertRefTraitInvariantOverFrames } from '../observer/assert-ref-trait-invariant.js';
import { probeBindings } from '../observer/probe-bindings.js';
import { assertClickPathSample } from '../observer/assert-click-path-sample.js';
import { assertOrbitalIsolation } from '../observer/assert-orbital-isolation.js';
import { assertContractEventFired } from '../observer/assert-contract-event-fired.js';
import { assertDataMutation } from '../observer/assert-data-mutation.js';
import { assertCrudFlow } from '../observer/assert-crud-flow.js';
import { assertPortalPerStep } from '../observer/assert-portal-per-step.js';
import { assertInteractionPattern } from '../observer/assert-interaction-pattern.js';
import { assertClickNoListener } from '../observer/assert-click-no-listener.js';
import { report } from '../observer/report.js';
import type { Verdict } from '../observer/types.js';
import type { RunVerificationInput, RunVerificationOutput } from './types.js';

const DEFAULT_MAX_WALK_MS = 60_000;
const DEFAULT_MAX_FRAMES = 5_000;

export async function runVerification<Ctx extends DriverContext>(
  input: RunVerificationInput<Ctx>,
): Promise<RunVerificationOutput> {
  const log = input.options?.log ?? ((m: string) => { console.log(m); });
  const maxWalkMs = input.options?.maxWalkMs ?? DEFAULT_MAX_WALK_MS;
  const maxFrames = input.options?.maxFrames ?? DEFAULT_MAX_FRAMES;
  const opts = input.options ?? {};
  const allowStateless = opts.allowStateless === true;

  // ── Clear OUR artifacts from the output dir before starting ───────
  // Stale frames + transition logs + reports from a previous run
  // outlive the new run when the new run produces fewer artifacts
  // (e.g. fewer frames after a planner change), and they show up in
  // screenshot reviews as "ghost" results that don't reflect the
  // current state. Skipped when outputDir is empty (test-fixture mode).
  //
  // NEVER `rm -rf` the directory itself: callers have passed shared
  // dirs here (orbital-verify-unified passed the compiled-app scratch
  // ROOT when screenshots were off), and a recursive wipe deleted the
  // running app out from under its own dev server mid-walk. Only the
  // entries THIS pipeline writes are ours to delete.
  const outputDir = input.ctx.outputDir;
  if (outputDir !== undefined && outputDir !== '' && typeof process !== 'undefined' && process.versions?.node) {
    try {
      const { rmSync, mkdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      for (const artifact of ['frames', 'verify-report.json', 'transition-log.txt', 'transition-log.jsonl']) {
        rmSync(join(outputDir, artifact), { recursive: true, force: true });
      }
      mkdirSync(outputDir, { recursive: true });
    } catch { /* best-effort — keep going if FS errors */ }
  }

  // ── Derive everything from the parsed orbital ─────────────────────
  const traits = extractTraitWalkConfigs(input.orbital);
  // v3.14.0: orbital-wide entity field defs threaded into `planWalk`
  // for `success`-variant payload synthesis. Built once here so each
  // planWalk call doesn't re-walk the orbital.
  const entityFieldsByName = collectEntityFields(input.orbital);

  // Gap #13: trait-name → owning-orbital-name map. Threaded into `tick`
  // so the verifier dispatch bridge can construct the qualified
  // `UI:Orbital.Trait.EVENT` bus key — same scope shape codegen emits
  // and `useUIEvents` subscribes under. Without this the verifier
  // dispatches into a bus key no subscriber matches.
  const orbitalsByTrait = new Map<string, string>();
  for (const orb of input.orbital.orbitals) {
    for (const traitRef of orb.traits) {
      let name: string | undefined;
      if (typeof traitRef === 'string') {
        const parts = traitRef.split('.');
        name = parts[parts.length - 1];
      } else if ('ref' in traitRef && typeof traitRef.ref === 'string') {
        const parts = traitRef.ref.split('.');
        name = traitRef.name ?? parts[parts.length - 1];
      } else if ('name' in traitRef && typeof traitRef.name === 'string') {
        name = traitRef.name;
      }
      if (name) orbitalsByTrait.set(name, orb.name);
    }
  }

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
  if (opts.enableUserCrudFlow !== false) {
    collectExtension(planUserCrudFlow(input.orbital));
  }
  if (opts.enableTickTests !== false) {
    for (const trait of traits) {
      collectExtension(planTickTests({ trait }));
    }
  }
  if (opts.enableEmitSweep !== false) {
    // An emit nothing transitions on is a broadcast contract (GAME_END,
    // canvas tile/hover events with no handler): driving it through the
    // bus is a no-op by design, and the binding probe then flags the
    // frame as an undelivered dispatch. Sweep only events at least one
    // bound trait actually accepts with a transition.
    const acceptedEvents = new Set<string>();
    for (const t of traits) {
      for (const transition of t.transitions) acceptedEvents.add(transition.event);
    }
    for (const trait of traits) {
      const emits = emitSweepDeclarations(trait);
      if (emits.length > 0) {
        collectExtension(
          planEmitSweep({ trait, emits }).filter((step) => acceptedEvents.has(step.event)),
        );
      }
    }
  }

  // ── Walk every trait through the same tick loop ───────────────────
  const frames: Frame[] = [];
  const wholePlan: ExtendedWalkStep[] = [];
  // REPLAY-NONDET-DISPATCH: hops whose reconcile frame landed somewhere
  // other than the replay plan projected (a guarded edge branched).
  const replayDivergences: string[] = [];
  const replayDivergeFrames: number[] = [];

  for (const trait of traits) {
    const ctx = { ...input.ctx, trait } as Ctx;

    if (input.driver.beforeTrait !== undefined) {
      await input.driver.beforeTrait(ctx);
    }
    await input.driver.reset(ctx);

    const baseSteps = planWalk({ trait, entityFieldsByName });
    const extensionSteps = extensionStepsByTrait.get(trait.traitName) ?? [];
    const plan = [...baseSteps, ...extensionSteps];
    wholePlan.push(...plan);

    log(
      `[runVerification] ${trait.traitName}: ${plan.length} steps (${baseSteps.length} base + ${extensionSteps.length} extension)`,
    );

    const traitStart = Date.now();
    let prev: Frame | null = null;
    let stepIdx = 0;

    // Hermetic-frame mode (the default as of v3.13). Before each
    // non-auto-init step the kernel:
    //   1. Calls `driver.reset(ctx)` — page reload + bridge.reset hook
    //      (which the consuming tool wires to also POST mock-reset to
    //      the playground / compiled-server backing store).
    //   2. Walks the trait from `trait.initialState` to `step.from` via
    //      `planReplayTo`. Each replay event becomes its own kernel-
    //      injected `reconcile` Frame so the audit trail stays honest.
    //   3. Runs the original step.
    //
    // The auto-init step (always first per trait) skips the preamble
    // because it IS the post-reset state credit. After the reset,
    // walking initial→from gives the planner's `from` precondition for
    // free without forcing every planner to topology-order its own
    // emissions, which is what bit `planUserCrudFlow.crud-create` when
    // `planInteractionTests` left ListItemCreate in `open`.
    for (const step of plan) {
      if (frames.length >= maxFrames) {
        log(`[runVerification] ${trait.traitName}: maxFrames (${maxFrames}) reached`);
        break;
      }
      if (Date.now() - traitStart > maxWalkMs) {
        log(`[runVerification] ${trait.traitName}: maxWalkMs (${maxWalkMs}) exceeded at step ${stepIdx}/${plan.length}`);
        break;
      }

      // Hermetic preamble (skips for auto-init, which IS the boot
      // moment and has no prior state to reset from).
      if (step.triggerKind !== 'auto-init') {
        await input.driver.reset(ctx);

        if (step.from !== trait.initialState) {
          const replayPath = planReplayTo(
            { trait, targetState: step.from },
            entityFieldsByName,
          );
          for (const replayStep of replayPath) {
            if (frames.length >= maxFrames) break;
            const reconcileStep: ExtendedWalkStep = {
              ...replayStep,
              triggerKind: 'reconcile',
              coverageKey: `${trait.traitName}:${replayStep.from}+${replayStep.event}->${replayStep.to}[reconcile]`,
            };
            const reconcileFrame: Frame = await tick(input.driver, ctx, prev, reconcileStep, orbitalsByTrait, allowStateless);
            frames.push(reconcileFrame);
            log(`  [${stepIdx + 1}/${plan.length}] reconcile ${reconcileStep.from} --${reconcileStep.event}--> ${reconcileStep.to}`);
            prev = reconcileFrame;

            // REPLAY-NONDET-DISPATCH: the preamble BFS assumes one target
            // per (from, event), but a guarded transition branches. If the
            // runtime took the other branch, the rest of the preamble is
            // built on a stale precondition — abort it and record the
            // divergent hop so it can't silently corrupt the real step.
            if (
              reconcileFrame.stateAfter !== null &&
              reconcileFrame.stateAfter !== reconcileStep.to
            ) {
              replayDivergences.push(
                `${trait.traitName}: reconcile ${reconcileStep.from} --${reconcileStep.event}--> expected ${reconcileStep.to}, runtime reached ${reconcileFrame.stateAfter}`,
              );
              replayDivergeFrames.push(reconcileFrame.index);
              log(`  [${stepIdx + 1}/${plan.length}] replay diverged at ${reconcileStep.event}: expected ${reconcileStep.to}, got ${reconcileFrame.stateAfter} — aborting preamble`);
              break;
            }
          }
        }
      }

      const frame: Frame = await tick(input.driver, ctx, prev, step, orbitalsByTrait, allowStateless);
      frames.push(frame);
      const status = frame.accepted ? 'OK' : 'REJECTED';
      log(`  [${stepIdx + 1}/${plan.length}] ${step.from} --${step.event}--> ${step.to} | ${status}`);
      prev = frame;
      stepIdx += 1;

      // Run the per-frame settle hook (e.g. interactive annotation
      // overlay). Wrapped in try/catch so a hook failure can't take
      // down a long verifier walk — see `RunVerificationInput.options.
      // onFrameSettle` jsdoc for the contract. Hooks that need hard-
      // stop semantics call `process.exit` themselves.
      const onFrameSettle = input.options?.onFrameSettle;
      if (onFrameSettle !== undefined) {
        try {
          await onFrameSettle(ctx, frame);
        } catch (err) {
          log(`  onFrameSettle error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // ── Run observers ─────────────────────────────────────────────────
  const verdicts: RunVerificationOutput['verdicts'] = {};

  // VG6 — ref-trait invariant (always runs).
  verdicts.refTrait = assertRefTraitInvariantOverFrames(frames);

  // GUARD-LAMBDA-DROP — in-run guard prediction vs runtime accept parity.
  verdicts.guardParity = assertGuardParity(frames);

  // REPLAY-NONDET-DISPATCH — only surfaced when a reconcile hop diverged.
  if (replayDivergences.length > 0) {
    verdicts.replayDiverged = {
      passed: false,
      detail: `replay-diverged: ${replayDivergences.length} hop(s) branched off the replay plan — ${replayDivergences.join('; ')}`,
      evidence: { frameIndices: replayDivergeFrames },
    };
  }

  // End-of-walk portal blank-portal sweep (always).
  //
  // Pass the set of "lifecycle"-capability traits so frames originating
  // from side-effect-only atoms (std-audit-capture, std-cascade-on-delete,
  // std-notify-on-event, std-lifecycle, std-reminder-scheduler,
  // std-row-access-control, std-cross-reference) are skipped. Those atoms
  // declare `[lifecycle, instance, …]` in their .lolo source — they hook
  // into events and don't render UI, so the slot-mounted-empty signal is
  // expected, not a bug.
  // The .lolo bracket `[lifecycle, instance, …]` lowers into THREE separate
  // fields on the compiled trait: `category` (first slot — semantic class),
  // `scope` (second slot — instance/collection), and `capabilities` (remaining
  // slots). Side-effect-only atoms are signaled by `category: "lifecycle"`,
  // NOT a "lifecycle" entry in capabilities (the lowerer doesn't put it there).
  // Earlier check was looking at the wrong field; this is the corrected form.
  const noRenderTraits = new Set<string>();
  for (const orb of input.orbital.orbitals) {
    for (const traitRef of orb.traits ?? []) {
      // TraitRef = string | {ref, …} | Trait (inline). Only inline-trait
      // form carries category/capabilities; the ref-object form points at
      // an atom whose metadata lives in the embedded registry and is
      // inlined by the resolver before this code runs.
      if (typeof traitRef === 'string') continue;
      const t = traitRef as { name?: string; category?: string; capabilities?: string[] };
      if (!t.name) continue;
      // Primary signal: trait category is "lifecycle" (audit-capture,
      // cascade-on-delete, notify-on-event, reminder-scheduler, lifecycle,
      // row-access-control, cross-reference). Defensive secondary: also
      // treat a "lifecycle" entry in capabilities as the same signal, in
      // case future lowering preserves the bracket in that field instead.
      const isLifecycle =
        t.category === 'lifecycle' ||
        (t.capabilities ? t.capabilities.includes('lifecycle') : false);
      if (isLifecycle) {
        noRenderTraits.add(t.name);
      }
    }
  }
  verdicts.portalSweep = assertPortalSlots(frames, { noRenderTraits });

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

  // Gap #13 — orbital isolation. Detects cross-orbital trait
  // contamination at runtime: a dispatch from trait T in orbital A
  // shouldn't drive any trait outside A unless an explicit
  // cross-orbital `listens` channel is declared for that source.
  // Defense-in-depth alongside the L1/L2 listens-integrity checks.
  const orbitalIsolationVerdicts = assertOrbitalIsolation(frames, input.orbital);
  if (orbitalIsolationVerdicts.length > 0) {
    verdicts.orbitalIsolation = combineVerdicts(orbitalIsolationVerdicts, 'orbital-isolation');
  }

  // Gap #0 — bus:click-no-listener. Fails when a DOM click emits a bus
  // event with zero matching trait subscribers.
  const clickNoListenerVerdicts = assertClickNoListener(frames, input.orbital);
  if (clickNoListenerVerdicts.length > 0) {
    verdicts.clickNoListener = combineVerdicts(clickNoListenerVerdicts, 'click-no-listener');
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

  // v3.7.0 — CRUD-proof phase: emit + entity diff + DOM list update.
  const crudVerdicts = assertCrudFlow(frames, opts.storageTier ?? 'strict');
  if (crudVerdicts.length > 0) {
    verdicts.crud = combineVerdicts(crudVerdicts, 'crud');
  }

  // VG1 per-step — derived from each transition's render-ui declarations.
  if (opts.enablePortalPerStep !== false) {
    const portalExpectations = derivePortalExpectations(input.orbital);
    if (portalExpectations.length > 0) {
      const v = assertPortalPerStep(frames, portalExpectations);
      if (v.length > 0) {
        verdicts.portalPerStep = combineVerdicts(v, 'portal');
      }
    }
  }

  // Emit-sweep and data-mutation frames are planned above and asserted by
  // assertContractEventFired / assertDataMutation. The legacy assertCascade /
  // assertMutation observers stay exported (tested, published API) but are
  // superseded here — removal is a next-major decision.

  // Schema-level coverage denominator: every transition declared across
  // the orbital's inline-trait state machines. `schemaTransitionKeys`
  // carries the same transitions as coverage bases so `coverage()` can
  // reconcile the plan's variant fan-out into one honest number.
  let schemaTransitions = 0;
  const schemaTransitionKeys: string[] = [];
  for (const { trait } of eachInlineTrait(input.orbital)) {
    for (const t of trait.stateMachine?.transitions ?? []) {
      schemaTransitions += 1;
      schemaTransitionKeys.push(`${trait.name}:${t.from}+${t.event}->${t.to}`);
    }
  }

  return report({
    itemName: input.itemName,
    frames,
    plan: wholePlan,
    verdicts,
    schemaTransitions,
    schemaTransitionKeys,
  });
}

// ── internal ─────────────────────────────────────────────────────────

/**
 * Build the emit-sweep declaration list for a trait: every event its
 * effects emit (`emit: { success, failure }` options) plus every
 * contract-declared event from `emits {}`, internal AND external scope.
 * `@config.<knob>` event-name references can't be dispatched as literals
 * — they resolve at inline/resolve time, so a surviving `@`-prefixed
 * name here is undispatchable and skipped. `planEmitSweep` dedupes.
 */
function emitSweepDeclarations(trait: TraitWalkConfig): EmitDeclaration[] {
  const out: EmitDeclaration[] = [];
  for (const event of trait.effectEmittedEvents ?? []) {
    out.push({ success: event });
  }
  for (const contract of trait.emitContracts ?? []) {
    if (contract.event.startsWith('@')) continue;
    out.push({ success: contract.event });
  }
  return out;
}

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
 * Walk the orbital's traits for `render-ui` effects and derive
 * `PortalExpectation[]` for `assertPortalPerStep`. Render sites scanned:
 *   - `transitions[].effects` — one expectation per transition render-ui.
 *   - `states[].onEntry` — one expectation per transition INTO the state
 *     (the entry effect fires whenever the state is reached).
 *   - trait-level `initialEffects` — keyed to the auto-init cause
 *     `(initial, INIT, initial)`; they run at mount.
 *
 * A render-ui whose `type` is a reactive binding (not a literal string,
 * e.g. `{ type: '@config.x' }`) is UNKNOWN: no expectation is emitted —
 * never treated as "slot cleared".
 */
export function derivePortalExpectations(
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
          const render = scanRenderUiEffect(effect);
          if (render === null) continue;
          result.push({
            traitName: trait.name,
            from: transition.from,
            event: transition.event,
            to: transition.to,
            slot: render.slot,
            pattern: render.pattern,
          });
        }
      }

      // `State.onEntry` is typed `string[]` (effect names) in core, but
      // compiled output may carry inline S-expr effects — scan array
      // entries defensively; bare string names can't be resolved here.
      for (const state of trait.stateMachine.states) {
        for (const entry of state.onEntry ?? []) {
          const render = scanRenderUiEffect(entry);
          if (render === null) continue;
          for (const transition of trait.stateMachine.transitions) {
            if (transition.to !== state.name) continue;
            result.push({
              traitName: trait.name,
              from: transition.from,
              event: transition.event,
              to: transition.to,
              slot: render.slot,
              pattern: render.pattern,
            });
          }
        }
      }

      const initialState = findInitialState(trait.stateMachine);
      if (initialState !== null) {
        for (const effect of trait.initialEffects ?? []) {
          const render = scanRenderUiEffect(effect);
          if (render === null) continue;
          result.push({
            traitName: trait.name,
            from: initialState,
            event: 'INIT',
            to: initialState,
            slot: render.slot,
            pattern: render.pattern,
          });
        }
      }
    }
  }
  return result;
}

/**
 * Project one effect node into `{ slot, pattern }`, or `null` when the
 * node is not a scannable render-ui effect. `pattern: null` means the
 * transition explicitly clears the slot (no payload / no `type` key).
 * A payload whose `type` is present but NOT a literal string is a
 * reactive binding — the pattern is unknown, so the effect is skipped
 * entirely rather than asserted as a cleared slot.
 */
function scanRenderUiEffect(effect: unknown): { slot: string; pattern: string | null } | null {
  if (!Array.isArray(effect)) return null;
  if (effect[0] !== 'render-ui') return null;
  const slot = typeof effect[1] === 'string' ? effect[1] : null;
  if (slot === null) return null;
  const payload: unknown = effect[2];
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const t = (payload as { type?: unknown }).type;
    // A reactive binding — string form (`'@config.x'`) or an S-expr —
    // resolves at runtime; the pattern is UNKNOWN, so skip the effect
    // rather than assert anything (pre-fix this fell through to
    // `pattern: null`, which asserts the slot was CLEARED).
    if (typeof t === 'string' && t.startsWith('@')) return null;
    if (t !== undefined && typeof t !== 'string') return null;
    if (typeof t === 'string') return { slot, pattern: t };
  }
  return { slot, pattern: null };
}
