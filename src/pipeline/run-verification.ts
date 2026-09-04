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
import { collectEmbeddedTraitReferrers } from '@almadar/core';
import type { EntityRow, EventPayload } from '@almadar/core';
import { createMinimalContext, evaluateGuard } from '@almadar/evaluator';
import type { Frame } from '../frame/types.js';
import { tick } from '../driver/tick.js';
import type { DriverContext } from '../driver/types.js';
import { planWalk } from '../planner/plan-walk.js';
import { extractTraitWalkConfigs } from '../planner/extract-trait-walk-configs.js';
import { collectEntityFields } from '../planner/internal/payload-synth.js';
import { eachInlineTrait, findInitialState, traitBootRenderSlots } from '../planner/internal/orbital-walk.js';
import { isUiFactoryBoard } from './ui-factory-board.js';
import { planClickPathSamples } from '../planner/plan-click-path-samples.js';
import { planContractEvents } from '../planner/plan-contract-events.js';
import { planDataMutationTests } from '../planner/plan-data-mutation-tests.js';
import { planInteractionTests } from '../planner/plan-interaction-tests.js';
import { planUserCrudFlow } from '../planner/plan-user-crud-flow.js';
import { planReplayTo } from '../planner/plan-replay-to.js';
import { planTickTests } from '../planner/plan-tick-tests.js';
import { planEmitSweep } from '../planner/plan-emit-sweep.js';
import {
  collectEntityIdBindingTransitions,
  collectPersistWriteTransitions,
  traitHasEntityIdBinding,
  type EntityIdBindingSource,
} from '../planner/internal/persist-binding.js';
import type { EmitDeclaration } from '../browser/catalog-probes.js';
import type { ExtendedWalkStep } from '../planner/types.js';
import type { TraitWalkConfig, WalkTransition } from '../engine/types.js';
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
import type { ReportShape, Verdict, WalkBudgetEntry } from '../observer/types.js';
import type { RunVerificationInput, RunVerificationOutput } from './types.js';

// GAP 3 (coverage accounting): the closure-BFS reachability fix
// (`planReplayTo`) makes MORE transitions legitimately attemptable —
// e.g. std-data-erasure's `browsing`/`error`-state transitions, reachable
// via a real reconcile hop through `OPEN` — but each newly-attempted
// precondition costs a full hermetic reset (page reload) + reconcile
// dispatch + settle on top of the real step's own reset/dispatch/settle.
// A complex atom's per-trait walk can legitimately need several minutes
// to exhaust its plan once every reachable transition is actually
// attempted (verified: std-data-erasure needed >60s to clear its
// `loading`-state steps alone before reaching `browsing`/`error`). The
// old 60s ceiling silently truncated the walk mid-plan, which read as
// "uncovered" rather than "ran out of time" — raising the ceiling lets
// genuinely-reachable work finish instead of masking it as a skip.
//
// 180s (2026-09-03, DEFECT 2): still too tight — measured std-service-
// docker's ServiceDockerDocker trait (28 authored transitions, a 7-arm
// `match @entity.op`) hitting the ceiling at 49/84 plan steps / 182s, ~3.7s
// per step average, so its full plan needs ~310s and its many-armed match's
// emit-sweep extension steps (appended AFTER the base topology walk, same
// budget — see DEFECT 3) never got a turn. Raised to match the
// already-established "standard" tier budget this repo uses for a node
// verify engine elsewhere (`orb verify`'s unified CLI: 600s standard / 1800s
// deep, `Almadar_Verification.md`'s Unified CLI section) rather than invent
// a new number — 600s clears docker's measured ~310s with ~2x headroom.
const DEFAULT_MAX_WALK_MS = 600_000;
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

  // Frontier scope: traits cloned from a `uses[]` import carry the
  // resolve/inline phase's `sourceBehavior` stamp — their topology is
  // fixed by the imported atom and verified in that atom's own package
  // corpus, so the frontier walk skips their base topology and keeps
  // only the call-site wiring tests (extension planners). The IR's own
  // stamp is the sole discriminator; an unstamped trait is authored and
  // always walked in full.
  const frontier = opts.walkScope === 'frontier';
  const importedTopology = new Map<string, string>();
  if (frontier) {
    for (const { trait } of eachInlineTrait(input.orbital)) {
      if (trait.sourceBehavior !== undefined) {
        importedTopology.set(trait.name, trait.sourceBehavior.behavior);
      }
    }
  }
  const frontierSkipped: Array<{ trait: string; source: string; transitions: number }> = [];
  // v3.14.0: orbital-wide entity field defs threaded into `planWalk`
  // for `success`-variant payload synthesis. Built once here so each
  // planWalk call doesn't re-walk the orbital.
  const entityFieldsByName = collectEntityFields(input.orbital);

  // R-PERSIST-NO-ROW-KEY-SILENT-SUCCESS remedy (docs/Almadar_Runtime_Gaps.md
  // §R-PERSIST-NO-ROW-KEY-SILENT-SUCCESS): the hermetic walk resets the page
  // before every step, so a `persist update|delete` step can fire before
  // the id-binding transition that establishes `@entity.id` ever ran for
  // real — the write then resolves against an empty row key and silently
  // no-ops. Traits that legitimately establish their own row identity
  // (`traitHasEntityIdBinding` — the same condition the Rust static
  // validator checks before emitting `ORB_BINDING_PERSIST_ROW_ID_NEVER_SET`)
  // get that binding transition's dispatch corrected below to carry a REAL
  // seeded row's id instead of synthesized fake data. A trait with NO such
  // transition anywhere never gets touched — that IS the one real corpus
  // defect, and it must keep failing rather than being masked.
  const persistWriteByKey = collectPersistWriteTransitions(input.orbital);
  const entityIdBindingByTrait = new Map<string, ReadonlyMap<string, EntityIdBindingSource>>();
  const linkedEntityByTrait = new Map<string, string>();
  for (const { trait } of eachInlineTrait(input.orbital)) {
    if (trait.linkedEntity !== undefined) linkedEntityByTrait.set(trait.name, trait.linkedEntity);
    if (traitHasEntityIdBinding(trait)) {
      entityIdBindingByTrait.set(trait.name, collectEntityIdBindingTransitions(trait));
    }
  }

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
  // PRECONDITION-UNREACHABLE: steps whose `from` precondition couldn't be
  // established (no replay path found, or the replay diverged) — the step
  // is skipped rather than dispatched from a stale state (e.g. APPROVE
  // firing while the trait sat in `idle` because `reviewing` was never
  // reached). Mirrors how the base walk already accepts it can't force an
  // unsteerable guard outcome (`assertGuardParity`'s `guardSteerable`
  // skip) instead of flagging a divergence the planner has no control over.
  const preconditionSkips: string[] = [];

  // WALK-BUDGET-EXCEEDED: a trait whose plan didn't finish because
  // `maxWalkMs`/`maxFrames` fired mid-plan, not because every step ran.
  // Recorded structurally (not just logged — `log` is a no-op in some
  // callers) so a truncated run is distinguishable from an authoring bug:
  // both leave the same transitions in `coverage.uncovered`, but only this
  // says WHY.
  const walkBudgetEntries: WalkBudgetEntry[] = [];

  for (const trait of traits) {
    const importedSource = frontier ? importedTopology.get(trait.traitName) : undefined;
    if (importedSource !== undefined) {
      frontierSkipped.push({
        trait: trait.traitName,
        source: importedSource,
        transitions: trait.transitions.length,
      });
    }
    const extensionSteps = extensionStepsByTrait.get(trait.traitName) ?? [];
    // Imported traits keep ONLY the dispatch-free auto-init step (and only
    // when wiring steps follow): it settles the freshly-reset page and
    // credits the boot mount before the first real dispatch. Without it
    // the first extension step fires into a still-hydrating page and
    // flakes with `frame 0: dispatch failed`.
    const baseSteps = importedSource === undefined
      ? planWalk({ trait, entityFieldsByName })
      : extensionSteps.length > 0
        ? planWalk({ trait, entityFieldsByName }).filter((s) => s.triggerKind === 'auto-init')
        : [];
    const plan = [...baseSteps, ...extensionSteps];

    // An imported trait with no wiring steps has nothing to dispatch —
    // skip it before any driver work (the per-trait reset is a full page
    // reload; on organism-scale schemas these skips are the wall-clock
    // win frontier mode exists for).
    if (importedSource !== undefined && plan.length === 0) {
      log(`[runVerification] ${trait.traitName}: frontier skip (topology from ${importedSource}, ${trait.transitions.length} transitions verified at source)`);
      continue;
    }

    wholePlan.push(...plan);

    const ctx = { ...input.ctx, trait } as Ctx;

    if (input.driver.beforeTrait !== undefined) {
      await input.driver.beforeTrait(ctx);
    }
    await input.driver.reset(ctx);

    // Fetch a real seeded row for the id-binding seed (see the block
    // above `entityFieldsByName`): once per trait, right after the reset
    // every subsequent step's own hermetic reset also runs — the mock
    // store's seed is deterministic, so this row is the same one every
    // later reset in this trait's walk reproduces. Only fetched when the
    // plan actually contains a write that needs a pre-existing row
    // (`update`/`delete`, never `create`) AND the trait can legitimately
    // bind one; otherwise this is a wasted round-trip.
    const idBindings = entityIdBindingByTrait.get(trait.traitName);
    const traitLinkedEntity = linkedEntityByTrait.get(trait.traitName);
    let idSeedRow: EntityRow | null = null;
    if (
      idBindings !== undefined &&
      traitLinkedEntity !== undefined &&
      plan.some((s) => {
        const persist = persistWriteByKey.get(`${trait.traitName}:${s.from}+${s.event}->${s.to}`);
        return persist !== undefined && persist.kind !== 'create';
      })
    ) {
      const seedSnap = await input.driver.snapshot(ctx, null);
      const rows = seedSnap.entityData[traitLinkedEntity];
      idSeedRow = rows !== undefined && rows.length > 0 && rows[0].id !== undefined ? rows[0] : null;
    }

    log(
      `[runVerification] ${trait.traitName}: ${plan.length} steps (${baseSteps.length} base + ${extensionSteps.length} extension)${importedSource !== undefined ? ` — frontier: topology from ${importedSource} skipped` : ''}`,
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
        walkBudgetEntries.push({
          traitName: trait.traitName,
          reason: 'maxFrames',
          stepsCompleted: stepIdx,
          totalSteps: plan.length,
          elapsedMs: Date.now() - traitStart,
          maxWalkMs,
          stepsUnreached: plan.length - stepIdx,
        });
        break;
      }
      if (Date.now() - traitStart > maxWalkMs) {
        log(`[runVerification] ${trait.traitName}: maxWalkMs (${maxWalkMs}) exceeded at step ${stepIdx}/${plan.length}`);
        walkBudgetEntries.push({
          traitName: trait.traitName,
          reason: 'maxWalkMs',
          stepsCompleted: stepIdx,
          totalSteps: plan.length,
          elapsedMs: Date.now() - traitStart,
          maxWalkMs,
          stepsUnreached: plan.length - stepIdx,
        });
        break;
      }

      // Hermetic preamble (skips for auto-init, which IS the boot
      // moment and has no prior state to reset from).
      let preconditionUnreachable = false;
      let preconditionReason = '';
      if (step.triggerKind !== 'auto-init') {
        await input.driver.reset(ctx);

        // `from: '*'` fires on ANY current state — it has no precondition
        // to establish, so an empty replay path here is correct-by-design,
        // not a reachability failure.
        if (step.from !== trait.initialState && step.from !== '*') {
          const replayPath = planReplayTo(
            { trait, targetState: step.from },
            entityFieldsByName,
          );
          if (replayPath === null) {
            // Genuinely unreachable — no dispatchable hop's closure ever
            // lands on `step.from`. Distinct from `[]`, which means the
            // precondition is already satisfied with zero dispatches
            // (already-there, or within the initial state's own closure).
            preconditionUnreachable = true;
            preconditionReason = `precondition '${step.from}' unreachable from '${trait.initialState}' — no dispatchable replay path (or transient-closure landing) found`;
          }
          for (const replayStep of replayPath ?? []) {
            if (frames.length >= maxFrames) break;
            const reconcileStep: ExtendedWalkStep = seedEntityIdIfBinding(
              {
                ...replayStep,
                triggerKind: 'reconcile',
                coverageKey: `${trait.traitName}:${replayStep.from}+${replayStep.event}->${replayStep.to}[reconcile]`,
              },
              idBindings,
              idSeedRow,
            );
            // Captured before `prev` is reassigned below — the entity/state
            // the dispatch actually saw, for `siblingGuardSatisfiable`.
            const beforeReconcileFrame = prev;
            const reconcileFrame: Frame = await tick(input.driver, ctx, prev, reconcileStep, orbitalsByTrait, allowStateless);
            frames.push(reconcileFrame);
            log(`  [${stepIdx + 1}/${plan.length}] reconcile ${reconcileStep.from} --${reconcileStep.event}--> ${reconcileStep.to}`);
            prev = reconcileFrame;

            // REPLAY-NONDET-DISPATCH: the preamble BFS assumes one target
            // per (from, event), but a guarded transition branches, or a
            // mocked effect resolves inside the settle window and the
            // trait auto-advances past `reconcileStep.to` before the frame
            // is read (e.g. `empty --FETCH--> loading` settling at
            // `cached`). The latter is the same legitimate race
            // `planWalk`/`tick` already tolerate on direct steps via
            // `acceptStates` (transient closure) — reconcile hops carry
            // the identical closure (`planReplayTo`), so accept any state
            // in it here too. Only a state OUTSIDE the closure is a real
            // divergence.
            const reconcileAccepted = reconcileStep.acceptStates ?? [reconcileStep.to];
            if (
              reconcileFrame.stateAfter !== null &&
              !reconcileAccepted.includes(reconcileFrame.stateAfter)
            ) {
              // The other half of the branching case named above: when
              // `(from, event)` declares SEVERAL guarded targets, the BFS
              // planned one of them and the runtime's guard truth selected
              // another. Landing on a sibling declared target is the state
              // machine working, not nondeterminism — the replay simply
              // can't establish this precondition, which the skip below
              // already reports. Only a state NO transition declares for
              // this `(from, event)` is a genuine divergence.
              //
              // RECONCILE-SIBLING-CREDIT: a landing state matching some
              // OTHER declared target is necessary but not sufficient —
              // that sibling's own guard must actually admit the payload
              // dispatched, or "guard selected a declared sibling" is
              // crediting a branch no arm could have taken (masking "no
              // arm fired for synthesized payload" as legitimate
              // branching). `siblingGuardSatisfiable` re-evaluates each
              // candidate sibling's guard with the same evaluator the
              // runtime uses.
              const siblingArms = trait.transitions.filter(
                (t) => t.from === reconcileStep.from && t.event === reconcileStep.event,
              );
              const declaredTargets = siblingArms.map((t) => t.to);
              const firingSibling = siblingArms.find(
                (t) =>
                  t.to === reconcileFrame.stateAfter &&
                  siblingGuardSatisfiable(
                    t,
                    trait.traitName,
                    trait.linkedEntity,
                    reconcileStep.payload,
                    reconcileStep.from,
                    beforeReconcileFrame,
                  ),
              );
              const tookSiblingBranch = declaredTargets.length > 1 && firingSibling !== undefined;
              if (!tookSiblingBranch) {
                const divergenceDetail =
                  declaredTargets.length > 1 && declaredTargets.includes(reconcileFrame.stateAfter)
                    ? `no arm fired for synthesized payload — reconcile ${reconcileStep.from} --${reconcileStep.event}--> landed on declared sibling ${reconcileFrame.stateAfter}, but no candidate arm's guard admits the dispatched payload`
                    : `reconcile ${reconcileStep.from} --${reconcileStep.event}--> expected ${reconcileStep.to}, runtime reached ${reconcileFrame.stateAfter}`;
                replayDivergences.push(`${trait.traitName}: ${divergenceDetail}`);
                replayDivergeFrames.push(reconcileFrame.index);
                log(`  [${stepIdx + 1}/${plan.length}] replay diverged at ${reconcileStep.event}: ${divergenceDetail} — aborting preamble`);
              } else {
                log(`  [${stepIdx + 1}/${plan.length}] guard branch at ${reconcileStep.event}: planned ${reconcileStep.to}, guard selected ${reconcileFrame.stateAfter} (also declared) — aborting preamble`);
              }
              preconditionUnreachable = true;
              preconditionReason = `precondition '${step.from}' unreachable — reconcile ${reconcileStep.from} --${reconcileStep.event}--> expected ${reconcileStep.to}, runtime reached ${reconcileFrame.stateAfter}`;
              break;
            }
            // Accepted but past the exact target: the runtime already
            // settled beyond `reconcileStep.to` (transient overshoot), so
            // any remaining hops in this replay path assumed a precondition
            // that no longer holds. Stop replaying — same as tick.ts's
            // direct-step path, which never asserts an exact intermediate
            // state, only observes wherever the runtime actually is — and
            // let the real step fire from wherever the trait settled.
            if (
              reconcileFrame.stateAfter !== null &&
              reconcileFrame.stateAfter !== reconcileStep.to
            ) {
              log(`  [${stepIdx + 1}/${plan.length}] reconcile settled at ${reconcileFrame.stateAfter} (transient closure of ${reconcileStep.to}) — accepted, skipping remaining preamble hops`);
              break;
            }
          }
        }
      }

      // The precondition walk couldn't put the trait in `step.from` (no
      // replay path, or the replay diverged) — dispatching now would fire
      // from whatever stale state the reset left it in (e.g. APPROVE from
      // `idle` instead of `reviewing`) and report a misleading pass/fail
      // that says nothing about the transition itself. Skip it; the
      // divergence (if any) is already recorded via `replayDivergences`.
      if (preconditionUnreachable) {
        log(`  [${stepIdx + 1}/${plan.length}] SKIP ${step.from} --${step.event}--> ${step.to} | ${preconditionReason}`);
        preconditionSkips.push(`${trait.traitName}:${step.from}+${step.event}->${step.to} — ${preconditionReason}`);
        stepIdx += 1;
        continue;
      }

      // Covers the case where the persist-write step's OWN transition is
      // also the id-binding one (e.g. a self-contained "delete this row"
      // event that both `(set @entity.id @payload.id)` and persists in
      // one dispatch) — the reconcile-hop seeding above only reaches
      // binding transitions that are earlier hops on the replay path.
      const seededStep = seedEntityIdIfBinding(step, idBindings, idSeedRow);
      const frame: Frame = await tick(input.driver, ctx, prev, seededStep, orbitalsByTrait, allowStateless);
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

  // PRECONDITION-UNREACHABLE — informational, not a failure: a step whose
  // `from` state couldn't be established was skipped rather than fired
  // from a stale state. The transition still surfaces as uncovered in the
  // coverage report; this just names WHY, so the skip is traceable instead
  // of a silent drop.
  if (preconditionSkips.length > 0) {
    verdicts.preconditionSkipped = {
      passed: true,
      detail: `precondition-unreachable: ${preconditionSkips.length} step(s) skipped — ${preconditionSkips.join('; ')}`,
      evidence: { frameIndices: [] },
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

  // Embedded traits (`@trait.X` referenced from another trait's render-ui,
  // e.g. std-mod-queue's `LoadingSpinner`): a DECLARED wrapper trait
  // inherits a base ui atom's own `INIT -> (render-ui main ...)` topology,
  // but that self-render is sidecar-redirected — only the HOST trait's
  // render tree (wherever it places `@trait.LoadingSpinner`) actually
  // consumes it. Walking the embedded trait on its own (the base walk
  // treats every inline trait as independently walkable) auto-fires its
  // INIT and asserts against the literal DOM slot it declares, which the
  // embedded case never paints into — a false blank-portal/boot-expectation
  // flag. `collectEmbeddedTraitReferrers` (canonical owner: @almadar/core,
  // shared with @almadar/runtime's own config-forward resolution) is the
  // single source of truth for "is this trait embedded" — reused here
  // rather than re-walking `@trait.` references locally.
  const embeddedTraits = new Set(collectEmbeddedTraitReferrers(input.orbital).keys());
  for (const name of embeddedTraits) noRenderTraits.add(name);

  // `main` blank-portal exemption: derived from the schema, not a name
  // list. A trait whose boot `(initialState, INIT)` transition authors no
  // render-ui into `main` (std-modal: fetches at INIT, only ever renders
  // into its own detail/portal slot from a later OPEN) never promises
  // content there — the shell mounts `main` unconditionally regardless,
  // so an empty one is expected, not a bug. A trait that DOES author a
  // `main` render at boot and paints nothing still fails.
  const mainExemptTraits = new Set<string>();
  for (const { trait } of eachInlineTrait(input.orbital)) {
    if (!traitBootRenderSlots(trait).has('main')) mainExemptTraits.add(trait.name);
  }
  verdicts.portalSweep = assertPortalSlots(frames, { noRenderTraits, mainExemptTraits });

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
    // Embedded traits' own render-ui declarations never land in the
    // top-level DOM independently (see the portalSweep exemption above) —
    // no per-step boot/transition expectation applies to them either.
    // Factory boards (lolo-ui generator stamp): the boot INIT render is a
    // content vessel fed entirely by call-site config — with all knobs at
    // defaults it may legitimately collapse to nothing (e.g. simple-grid
    // with no children returns null). Boot INIT expectations are therefore
    // contractually soft there; non-INIT expectations stay strict.
    const vesselBoard = isUiFactoryBoard(input.orbital);
    const portalExpectations = derivePortalExpectations(input.orbital)
      .filter((e) => !embeddedTraits.has(e.traitName))
      .filter((e) => !(vesselBoard && e.event === 'INIT'));
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
  // reconcile the plan's variant fan-out into one honest number. Under
  // frontier scope the denominator covers only walked (authored) traits;
  // the skipped imported topology is accounted in `frontier` instead of
  // silently deflating the ratio.
  let schemaTransitions = 0;
  const schemaTransitionKeys: string[] = [];
  for (const { trait } of eachInlineTrait(input.orbital)) {
    if (frontier && importedTopology.has(trait.name)) continue;
    for (const t of trait.stateMachine?.transitions ?? []) {
      schemaTransitions += 1;
      schemaTransitionKeys.push(`${trait.name}:${t.from}+${t.event}->${t.to}`);
    }
  }

  let frontierSummary: ReportShape['frontier'];
  if (frontier) {
    const importedTransitionsSkipped = frontierSkipped.reduce((sum, s) => sum + s.transitions, 0);
    frontierSummary = {
      authoredTraits: traits.length - frontierSkipped.length,
      importedTraits: frontierSkipped.length,
      importedTransitionsSkipped,
      skipped: frontierSkipped,
    };
    log(
      `[runVerification] frontier: walked ${frontierSummary.authoredTraits} authored trait(s); skipped topology of ${frontierSummary.importedTraits} imported trait(s) (${importedTransitionsSkipped} transitions — verified at source)`,
    );
  }

  return report({
    itemName: input.itemName,
    frames,
    plan: wholePlan,
    verdicts,
    schemaTransitions,
    schemaTransitionKeys,
    ...(frontierSummary !== undefined && { frontier: frontierSummary }),
    ...(walkBudgetEntries.length > 0 && { walkBudget: walkBudgetEntries }),
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

/**
 * R-PERSIST-NO-ROW-KEY-SILENT-SUCCESS remedy: if `step` IS the trait's
 * own id-binding transition (`(from,event,to)` matches an entry
 * `collectEntityIdBindingTransitions` found for this trait), replace the
 * payload field its `(set @entity.id @payload.<path>)` reads from with a
 * REAL seeded row's id — dispatching it then binds `@entity.id` to a row
 * that genuinely exists in the store, exactly as if a real user had
 * selected it. A no-op for every other step (`bindings`/`seedRow`
 * undefined, or the step's transition isn't a binding one).
 */
function seedEntityIdIfBinding(
  step: ExtendedWalkStep,
  bindings: ReadonlyMap<string, EntityIdBindingSource> | undefined,
  seedRow: EntityRow | null,
): ExtendedWalkStep {
  if (bindings === undefined || seedRow === null || seedRow.id === undefined) return step;
  const binding = bindings.get(`${step.from}+${step.event}->${step.to}`);
  if (binding === undefined) return step;
  return { ...step, payload: setPayloadPath(step.payload, binding.payloadPath, seedRow.id) };
}

/** Set a dotted payload path (`"row.id"` → `{row: {id: value}}`) without disturbing sibling keys. */
function setPayloadPath(payload: EventPayload, path: string, value: string): EventPayload {
  const dot = path.indexOf('.');
  if (dot === -1) return { ...payload, [path]: value };
  const head = path.slice(0, dot);
  const rest = path.slice(dot + 1);
  const existing = payload[head];
  const nested: EventPayload = isPlainPayloadObject(existing) ? existing : {};
  return { ...payload, [head]: setPayloadPath(nested, rest, value) };
}

function isPlainPayloadObject(value: EventPayload[string] | undefined): value is EventPayload {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/**
 * The linked entity's first row as of `frame` — the entity binding a
 * guard's `@entity.*` references would have resolved against had the
 * runtime evaluated it at that moment. `null`/no rows for that entity
 * yields `{}` (no `@entity.field` guard can be satisfied against it,
 * which is the correct answer, not a crash).
 */
function entityRowForTrait(frame: Frame | null, traitName: string, linkedEntity: string | undefined): EntityRow {
  if (frame === null || linkedEntity === undefined) return {};
  const traitSnapshot = frame.runtimeSnapshot.traits.find((t) => t.traitName === traitName);
  const rows = traitSnapshot?.data[linkedEntity];
  return rows !== undefined && rows.length > 0 ? rows[0] : {};
}

/**
 * RECONCILE-SIBLING-CREDIT: whether `sibling`'s guard actually admits the
 * payload the kernel dispatched for this reconcile hop — using
 * `@almadar/evaluator`'s `evaluateGuard`, the same evaluator the real
 * runtime uses to decide guard truth. Before this check, the
 * reconcile-divergence assertion credited "guard selected a declared
 * sibling" whenever the runtime's landing state matched ANY OTHER arm's
 * declared `to`, with no check that arm's guard could plausibly have
 * fired for the payload sent — so "no arm fired at all" (a real
 * divergence, e.g. the `object/has` gap rejecting every candidate) was
 * indistinguishable from a legitimate guard branch. An unguarded sibling
 * is trivially satisfiable (nothing to fail); a guarded one is evaluated
 * against the entity/payload/state the dispatch actually used. A guard
 * evaluation error counts as unsatisfiable, mirroring
 * `playCircuitStep`'s "a guard error counts as a fail" contract.
 */
function siblingGuardSatisfiable(
  sibling: WalkTransition,
  traitName: string,
  linkedEntity: string | undefined,
  payload: EventPayload,
  fromState: string,
  beforeFrame: Frame | null,
): boolean {
  if (sibling.guard === undefined || sibling.guard === null) return true;
  const entity = entityRowForTrait(beforeFrame, traitName, linkedEntity);
  const ctx = createMinimalContext(entity, payload, fromState);
  try {
    return evaluateGuard(sibling.guard, ctx);
  } catch {
    return false;
  }
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
  // Every failing site, not just the first — an agent fixing dead buttons
  // needs the complete (trait, event) list in the verdict itself
  // (V-CLICK-NO-LISTENER-FIRST-SAMPLE-ONLY).
  return {
    passed: false,
    detail: `${label}: ${failed.length}/${verdicts.length} failed — ${failed.map((f) => f.detail).join('; ')}`,
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
  delta: import('../observer/types.js').BindingDelta,
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
      if ('ref' in traitRef && typeof (traitRef as { ref?: string }).ref === 'string') continue;
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
function scanRenderUiEffect(effect: import('@almadar/core').Effect | import('@almadar/core').SExpr): { slot: string; pattern: string | null } | null {
  if (!Array.isArray(effect)) return null;
  if (effect[0] !== 'render-ui') return null;
  const slot = typeof effect[1] === 'string' ? effect[1] : null;
  if (slot === null) return null;
  const payload = effect[2];
  if (payload !== null && payload !== undefined && typeof payload === 'object' && !Array.isArray(payload)) {
    const t = (payload as Readonly<Record<string, import('@almadar/core').SExpr>>)['type'];
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
