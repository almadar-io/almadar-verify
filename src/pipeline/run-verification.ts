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
import type { EntityData, EntityRow, EventPayload, Orbital } from '@almadar/core';
import { createMinimalContext, evaluateGuard } from '@almadar/evaluator';
import type { Frame } from '../frame/types.js';
import { tick, resolveEstablishRowPayload } from '../driver/tick.js';
import type { DriverContext } from '../driver/types.js';
import { pickTargetRow } from '../planner/internal/self-relation-fields.js';
import { planWalk } from '../planner/plan-walk.js';
import { extractTraitWalkConfigs } from '../planner/extract-trait-walk-configs.js';
import { resolveTraitNames } from '../planner/trait-scope.js';
import { collectEntityFields } from '../planner/internal/payload-synth.js';
import { eachInlineTrait, findInitialState, traitBootRenderSlots } from '../planner/internal/orbital-walk.js';
import { scanRenderUiEffect } from '../planner/internal/render-ui-scan.js';
import { planTransientFailureProbes, type TransientFailureProbeResult } from '../planner/plan-transient-failure-probes.js';
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
import { assertWalkStepsFired } from '../observer/assert-walk-fired.js';
import { assertPortalSlots } from '../observer/assert-portal.js';
import { assertRefTraitInvariantOverFrames } from '../observer/assert-ref-trait-invariant.js';
import { probeBindings } from '../observer/probe-bindings.js';
import { assertClickPathSample } from '../observer/assert-click-path-sample.js';
import { assertOrbitalIsolation } from '../observer/assert-orbital-isolation.js';
import { assertContractEventFired } from '../observer/assert-contract-event-fired.js';
import { assertDataMutation } from '../observer/assert-data-mutation.js';
import { assertCrudFlow } from '../observer/assert-crud-flow.js';
import { assertPortalPerStep, assertTransientFailureArmPortals, assertSlotShowsForeignTransitionRender } from '../observer/assert-portal-per-step.js';
import { assertListensEdgeNeverFired } from '../observer/listens-edge-never-fired.js';
import { assertBusItemCascadedNTimes } from '../observer/assert-cascade.js';
import { assertInteractionPattern } from '../observer/assert-interaction-pattern.js';
import { assertClickNoListener } from '../observer/assert-click-no-listener.js';
import { assertEmitPayloadAlwaysEmpty } from '../observer/emit-payload-always-empty.js';
import { assertEffectFailureNotSurfaced } from '../observer/effect-failure-not-surfaced.js';
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
  // C1-V15 item A: `establishesRow.traitName` (guard-precondition.ts) may
  // name a SIBLING trait to dispatch the preamble against, not the guarded
  // step's own trait — this map is how the `beforeReplay` block below
  // resolves that trait's own initial state (the preamble is always a
  // dispatch FROM that trait's own boot state, same as `trait.initialState`
  // is for the same-trait C1-V8/V14 shape).
  const traitWalkConfigsByName = new Map(traits.map((t) => [t.traitName, t]));

  // `--trait` scope (owner ruling 2026-09-11): resolved ONCE against the
  // full trait set above — `traitWalkConfigsByName` and every sibling
  // map built below stay UNSCOPED (a scoped step's hermetic preamble may
  // still need to establish a precondition via a sibling trait outside
  // the named set), only the per-trait WALK LOOP below is restricted to
  // `walkTraits`. `resolveTraitNames` throws (rejecting this call) on an
  // unknown name, listing every available trait — never a silent no-op.
  const traitScope = opts.traits !== undefined && opts.traits.length > 0
    ? resolveTraitNames(input.orbital, opts.traits)
    : null;
  const walkTraits = traitScope === null ? traits : traits.filter((t) => traitScope.includes(t.traitName));
  if (traitScope !== null) {
    log(`[runVerification] [trait ${traitScope.join(', ')}] scoped walk: ${walkTraits.length}/${traits.length} trait(s)`);
  }

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
  // Trait name → its declaring `Orbital`, so `planEmitSweep` can call the
  // same `dispatchNavigates` oracle `planClickPathSamples`/`planWalk` use
  // (needs the full schema + the trait's own orbital to resolve a
  // listener-cascade navigate, not just the trait's own transitions).
  const orbByTraitName = new Map<string, Orbital>();
  for (const { orb, trait } of eachInlineTrait(input.orbital)) {
    if (trait.linkedEntity !== undefined) linkedEntityByTrait.set(trait.name, trait.linkedEntity);
    if (traitHasEntityIdBinding(trait)) {
      entityIdBindingByTrait.set(trait.name, collectEntityIdBindingTransitions(trait));
    }
    orbByTraitName.set(trait.name, orb);
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
          planEmitSweep({ trait, emits, schema: input.orbital, orb: orbByTraitName.get(trait.traitName) })
            .filter((step) => acceptedEvents.has(step.event)),
        );
      }
    }
  }

  // RV item 27: transient failure-route arms (a `from` state that races
  // forward via an effect-emitted sibling before the walker's own
  // preamble can hold it for a manual dispatch of the failure event).
  // Computed from the SAME schema-derived portal expectations the
  // end-of-walk portal check reads below — `portalExpectations` is
  // reused there verbatim, so both stay in sync by construction. A
  // forced-failure probe step is planned per forceable arm; every
  // unforceable one becomes a `TransientArmFinding` instead of a step
  // that could never succeed.
  const embeddedTraits = new Set(collectEmbeddedTraitReferrers(input.orbital).keys());
  const vesselBoard = isUiFactoryBoard(input.orbital);
  const portalExpectations = derivePortalExpectations(input.orbital)
    .filter((e) => !embeddedTraits.has(e.traitName))
    .filter((e) => !(vesselBoard && e.event === 'INIT'));
  let transientFailureProbes: TransientFailureProbeResult = { steps: [], findings: [] };
  const transientArmKeys = new Set<string>();
  if (opts.enablePortalPerStep !== false) {
    const walkConfigsByName = new Map(walkTraits.map((t) => [t.traitName, t]));
    transientFailureProbes = planTransientFailureProbes(input.orbital, portalExpectations, walkConfigsByName);
    collectExtension(transientFailureProbes.steps);
    for (const step of transientFailureProbes.steps) {
      const v = step.verifiesPortalFor;
      if (v !== undefined) transientArmKeys.add(`${v.traitName}:${v.from}+${v.event}->${v.to}`);
    }
    for (const f of transientFailureProbes.findings) {
      transientArmKeys.add(`${f.traitName}:${f.from}+${f.event}->${f.to}`);
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

  for (const trait of walkTraits) {
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
      ? planWalk({ trait, entityFieldsByName, orbital: input.orbital })
      : extensionSteps.length > 0
        ? planWalk({ trait, entityFieldsByName, orbital: input.orbital }).filter((s) => s.triggerKind === 'auto-init')
        : [];
    attachRowContextFromDataMutation(baseSteps, extensionSteps);
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
    //
    // C1-V14 (F3): `driver.snapshot`'s `entityData` is the BROWSER'S
    // rendered subset — a page showing zero rows of the linked entity
    // yields no seed row even when the store has one server-side, leaving
    // the reconcile hop's `@entity.id` binding on a SYNTHESIZED id
    // (`persist failed: Entity X with id <fake> not found`). Prefer the
    // driver's server-truth row set (`listEntityRows`) when available;
    // fall back to the snapshot exactly as before when it's absent or
    // throws. Picked with the SAME `pickTargetRow` discipline `tick()`
    // uses for every other row pick in this package (no second picker) —
    // `serverRows === visibleRows` here reproduces the pre-existing
    // snapshot-only behavior exactly (see `pickTargetRow`'s own doc).
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
      let idSeedRows: ReadonlyArray<EntityRow> | undefined;
      if (input.driver.listEntityRows !== undefined) {
        try {
          idSeedRows = await input.driver.listEntityRows(ctx, traitLinkedEntity);
        } catch {
          idSeedRows = undefined;
        }
      }
      const rows = idSeedRows ?? (await input.driver.snapshot(ctx, null)).entityData[traitLinkedEntity] ?? [];
      const pick = pickTargetRow(rows, rows, undefined);
      idSeedRow = 'row' in pick && pick.row.id !== undefined ? pick.row : null;
    }

    // C1-V9 item A: the app's own default persona, read ONCE per trait
    // (mirrors `idSeedRow` above) so `tick()` can restore it after a
    // `viewerRequirement`-bearing step switches away from it. Fetched
    // only when the plan actually contains such a step AND the driver
    // can answer — a wasted round-trip otherwise.
    const needsPersona = plan.some(
      (s) => s.viewerRequirement !== undefined || s.establishesRow?.viewerRequirement !== undefined,
    );
    const defaultPersona = needsPersona && input.driver.getPersona !== undefined
      ? await input.driver.getPersona(ctx)
      : undefined;

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
      let liveState: string | null = null;
      if (step.triggerKind !== 'auto-init') {
        await input.driver.reset(ctx);
        liveState = trait.initialState;

        // C1-V14 (F4): `beforeReplay` means this step's own replay path
        // (from the trait's initial state to `step.from`) never traverses
        // the transition that establishes this row (a BFS shortest path
        // never revisits its own source state, so a self-loop AT the
        // initial state is never a hop on a path to a DIFFERENT state
        // reached FROM it — PF's `CREATE_TASK: backlog -> backlog` vs
        // `MOVE_STAGE: in_progress -> in_progress`, replayed via
        // `START_TASK: backlog -> in_progress`). Dispatch it HERE, as its
        // own reconcile frame, before the replay hops below run — they
        // (and the real step after them) need the row to already exist.
        // Never scored as a data-mutation test (no `testKind`).
        if (step.establishesRow?.beforeReplay === true) {
          const preamble = step.establishesRow;
          // C1-V15 item A: dispatch against the preamble's OWN trait when
          // it names one (the sibling-establishes-a-guard-precondition
          // shape) — else the guarded step's own trait, the original
          // C1-V8/V14 same-trait shape. Either way the preamble fires FROM
          // that trait's own initial state: a fresh `driver.reset` just ran
          // above, so every trait in the orbital is at its own boot state.
          const establishTraitName = preamble.traitName ?? trait.traitName;
          const establishTraitConfig = traitWalkConfigsByName.get(establishTraitName);
          const establishInitialState = establishTraitConfig?.initialState ?? trait.initialState;
          // C1-V16: `establishAtState` (guard-precondition.ts) may name a
          // state PAST the establishing trait's own initial state — a
          // setter arm that only exists once the trait has moved on
          // (std-thread's `EDIT_REPLY` at `browsing`, not `idle`). Firing
          // the preamble straight off `driver.reset` (the pre-existing
          // behavior, always dispatching AT `establishInitialState`) would
          // silently no-op: no arm for that event exists at the boot
          // state. Replay to it first, as its own reconcile frames — same
          // machinery the real step's own `from`-precondition replay uses
          // below, just walking the ESTABLISHING trait instead.
          const establishTargetState = preamble.establishAtState ?? establishInitialState;
          let establishReplayFailed = false;
          if (establishTargetState !== establishInitialState) {
            if (establishTraitConfig === undefined) {
              preconditionUnreachable = true;
              preconditionReason =
                `precondition '${step.from}' unreachable — establishing trait '${establishTraitName}' has no ` +
                `walk config to replay to '${establishTargetState}'`;
              establishReplayFailed = true;
            } else {
              const establishReplayPath = planReplayTo(
                { trait: establishTraitConfig, targetState: establishTargetState },
                entityFieldsByName,
              );
              if (establishReplayPath === null) {
                preconditionUnreachable = true;
                preconditionReason =
                  `precondition '${step.from}' unreachable — establishing trait '${establishTraitName}' cannot ` +
                  `reach '${establishTargetState}' from its initial state '${establishInitialState}'`;
                establishReplayFailed = true;
              } else {
                for (const replayStep of establishReplayPath) {
                  if (frames.length >= maxFrames) break;
                  const establishReconcileStep: ExtendedWalkStep = {
                    ...replayStep,
                    triggerKind: 'reconcile',
                    coverageKey: `${establishTraitName}:${replayStep.from}+${replayStep.event}->${replayStep.to}[establish-reconcile]`,
                  };
                  const establishReconcileFrame: Frame = await tick(
                    input.driver, ctx, prev, establishReconcileStep, orbitalsByTrait, allowStateless, defaultPersona,
                  );
                  frames.push(establishReconcileFrame);
                  log(`  [${stepIdx + 1}/${plan.length}] establish-reconcile (${establishTraitName}) ${establishReconcileStep.from} --${establishReconcileStep.event}--> ${establishReconcileStep.to}`);
                  prev = establishReconcileFrame;
                  if (establishReconcileFrame.cause.traitName === trait.traitName && establishReconcileFrame.stateAfter !== null) liveState = establishReconcileFrame.stateAfter;
                  const establishReconcileAccepted = establishReconcileStep.acceptStates ?? [establishReconcileStep.to];
                  if (
                    establishReconcileFrame.stateAfter !== null &&
                    !establishReconcileAccepted.includes(establishReconcileFrame.stateAfter)
                  ) {
                    preconditionUnreachable = true;
                    preconditionReason =
                      `precondition '${step.from}' unreachable — establish-reconcile ${establishReconcileStep.from} ` +
                      `--${establishReconcileStep.event}--> expected ${establishReconcileStep.to}, runtime reached ` +
                      `${establishReconcileFrame.stateAfter}`;
                    establishReplayFailed = true;
                    break;
                  }
                }
              }
            }
          }
          if (!establishReplayFailed) {
            let entitiesBeforePreamble: EntityData = {};
            if (preamble.bindRowFrom !== undefined) {
              entitiesBeforePreamble = (await input.driver.snapshot(ctx, null)).entityData;
            }
            const resolved = resolveEstablishRowPayload(preamble, establishTraitName, entitiesBeforePreamble, undefined);
            const establishStep: ExtendedWalkStep = {
              from: establishTargetState,
              event: preamble.event,
              to: establishTargetState,
              guardCase: null,
              payload: 'payload' in resolved ? resolved.payload : {},
              // Mirrors `planReplayTo`'s own reconcile hops: not a scored
              // test step, so guard-parity / portal-per-step observers skip
              // it exactly like a replay hop.
              isRepositioning: true,
              traitName: establishTraitName,
              triggerKind: 'reconcile',
              coverageKey: `${establishTraitName}:${establishTargetState}+${preamble.event}->${establishTargetState}[establish-row]`,
              ...('unreachableRow' in resolved && { unreachableRowReason: resolved.unreachableRow }),
              ...(preamble.viewerRequirement !== undefined && { viewerRequirement: preamble.viewerRequirement }),
            };
            const establishFrame: Frame = await tick(input.driver, ctx, prev, establishStep, orbitalsByTrait, allowStateless, defaultPersona);
            frames.push(establishFrame);
            log(`  [${stepIdx + 1}/${plan.length}] establish-row (${establishTraitName}) ${establishStep.from} --${establishStep.event}--> ${establishStep.to}`);
            prev = establishFrame;
            if (establishFrame.cause.traitName === trait.traitName && establishFrame.stateAfter !== null) liveState = establishFrame.stateAfter;
            if ('unreachableRow' in resolved) {
              preconditionUnreachable = true;
              preconditionReason = `precondition '${step.from}' unreachable — row-establishing preamble '${preamble.event}' failed: ${resolved.unreachableRow}`;
            }
          }
        }

        // `from: '*'` fires on ANY current state — it has no precondition
        // to establish, so an empty replay path here is correct-by-design,
        // not a reachability failure.
        if (!preconditionUnreachable && step.from !== trait.initialState && step.from !== '*') {
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
              persistWriteByKey.get(`${trait.traitName}:${replayStep.from}+${replayStep.event}->${replayStep.to}`)?.kind,
            );
            // Captured before `prev` is reassigned below — the entity/state
            // the dispatch actually saw, for `siblingGuardSatisfiable`.
            const beforeReconcileFrame = prev;
            const reconcileFrame: Frame = await tick(input.driver, ctx, prev, reconcileStep, orbitalsByTrait, allowStateless, defaultPersona);
            frames.push(reconcileFrame);
            log(`  [${stepIdx + 1}/${plan.length}] reconcile ${reconcileStep.from} --${reconcileStep.event}--> ${reconcileStep.to}`);
            prev = reconcileFrame;
            if (reconcileFrame.cause.traitName === trait.traitName && reconcileFrame.stateAfter !== null) liveState = reconcileFrame.stateAfter;

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
      // G-VERIFY-043: a transient precondition the runtime settled past leaves no arm to test.
      const settled = liveState;
      if (
        !preconditionUnreachable && settled !== null && settled !== step.from && step.from !== '*' &&
        !trait.transitions.some((t) => (t.from === settled || t.from === '*') && t.event === step.event)
      ) {
        preconditionUnreachable = true;
        preconditionReason = `precondition '${step.from}' is transient — the runtime settled at '${settled}', which has no ${step.event} arm`;
      }

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
      const seededStep = seedEntityIdIfBinding(
        step,
        idBindings,
        idSeedRow,
        persistWriteByKey.get(`${trait.traitName}:${step.from}+${step.event}->${step.to}`)?.kind,
      );
      const frame: Frame = await tick(input.driver, ctx, prev, seededStep, orbitalsByTrait, allowStateless, defaultPersona);
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

  // A planned dispatch the runtime rejected is a finding, never coverage.
  const effectEmittedByTrait = new Map<string, ReadonlySet<string>>(
    traits.map((t) => [t.traitName, t.effectEmittedEvents ?? new Set<string>()]),
  );

  // PF-17c: initial states no transition leads back to (PF's
  // InvoiceLifecycle `draft` — one-shot by design). Once the walk advances
  // past one, later from-initial steps are unreachable whenever the reset
  // didn't restore it; `assertWalkStepsFired` skips those with a note.
  const oneShotInitialByTrait = new Map<string, string>();
  for (const t of traits) {
    const reenterable = t.transitions.some((tr) => tr.to === t.initialState && tr.from !== t.initialState);
    if (!reenterable) oneShotInitialByTrait.set(t.traitName, t.initialState);
  }

  // VG6 — ref-trait invariant (always runs).
  verdicts.refTrait = assertRefTraitInvariantOverFrames(frames);

  // GUARD-LAMBDA-DROP — in-run guard prediction vs runtime accept parity.
  verdicts.guardParity = assertGuardParity(frames, effectEmittedByTrait);

  verdicts.walk = assertWalkStepsFired(frames, effectEmittedByTrait, oneShotInitialByTrait);

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

  // emit-payload-always-empty — a declared emit payload field that fired
  // ≥2 times this session and was empty on every firing: live and wired,
  // never carries the value it promises.
  const emitPayloadAlwaysEmptyVerdicts = assertEmitPayloadAlwaysEmpty(frames, input.orbital);
  if (emitPayloadAlwaysEmptyVerdicts.length > 0) {
    verdicts.emitPayloadAlwaysEmpty = combineVerdicts(emitPayloadAlwaysEmptyVerdicts, 'emit-payload-always-empty');
  }

  // listens-edge-never-fired — the runtime twin of the compiler's
  // ORB_X_LISTEN_SOURCE_UNRESOLVED (the static listens-source-never-emits
  // lint duplicated this and was retired 2026-09-12): a declared listens
  // route whose source fired repeatedly this session but the listener's own
  // trigger was never observed firing — wired on paper, dead in practice.
  const listensEdgeNeverFiredVerdicts = assertListensEdgeNeverFired(frames, input.orbital);
  if (listensEdgeNeverFiredVerdicts.length > 0) {
    verdicts.listensEdgeNeverFired = combineVerdicts(listensEdgeNeverFiredVerdicts, 'listens-edge-never-fired');
  }

  // bus-item-cascaded-n-times — the SAME bus item delivered more than
  // once to one listener within a single dispatch window.
  const busItemCascadedNTimesVerdicts = assertBusItemCascadedNTimes(frames);
  if (busItemCascadedNTimesVerdicts.length > 0) {
    verdicts.busItemCascadedNTimes = combineVerdicts(busItemCascadedNTimesVerdicts, 'bus-item-cascaded-n-times');
  }

  // effect-failure-not-surfaced — a denied/failed persist/fetch/call-service
  // whose declared emit.failure never reaches the event log
  // (effect-failure-unrouted) or fires with no toast/alert ever mounted
  // (effect-failure-not-surfaced): a failed write with no consequence a
  // user can see.
  const effectFailureVerdicts = assertEffectFailureNotSurfaced(frames, input.orbital);
  if (effectFailureVerdicts.length > 0) {
    verdicts.effectFailureNotSurfaced = combineVerdicts(effectFailureVerdicts, 'effect-failure-not-surfaced');
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
    //
    // RV item 27: a transient failure-route arm (`transientArmKeys`,
    // computed up front alongside `planTransientFailureProbes`) is
    // excluded from the plain cause-matching check — its own dispatch
    // never literally lands on `(from, event, to)` by construction — and
    // routed to `assertTransientFailureArmPortals` instead, which reads
    // the forced probe's `verifiesPortalFor` + the runtime's own
    // cascade trace.
    const normalPortalExpectations = portalExpectations.filter(
      (e) => !transientArmKeys.has(`${e.traitName}:${e.from}+${e.event}->${e.to}`),
    );
    const transientPortalExpectations = portalExpectations.filter(
      (e) => transientArmKeys.has(`${e.traitName}:${e.from}+${e.event}->${e.to}`),
    );
    const portalVerdicts = [
      ...assertPortalPerStep(frames, normalPortalExpectations),
      ...assertTransientFailureArmPortals(frames, transientPortalExpectations),
    ];
    if (portalVerdicts.length > 0) {
      verdicts.portalPerStep = combineVerdicts(portalVerdicts, 'portal');
    }

    // slot-shows-foreign-transition-render — the runtime twin of compiler
    // §98's last-writer-per-slot contract: the DOM's own `data-pattern`
    // marker disagrees with the firing transition's declared pattern AND
    // matches a DIFFERENT known writer's — a stale/foreign render.
    const foreignRenderVerdicts = assertSlotShowsForeignTransitionRender(frames, normalPortalExpectations, effectEmittedByTrait);
    if (foreignRenderVerdicts.length > 0) {
      verdicts.slotShowsForeignTransitionRender = combineVerdicts(foreignRenderVerdicts, 'slot-shows-foreign-transition-render');
    }
  }

  // TRANSIENT-ARM-UNREACHABLE (RV item 27) — informational, not a
  // failure: every transient failure-route arm for which no denying
  // viewer could be derived, so its portal expectation was excluded
  // above rather than asserted against a dispatch that could never land
  // there.
  if (transientFailureProbes.findings.length > 0) {
    verdicts.transientArmUnreachable = {
      passed: true,
      detail: `transient-arm-unreachable: ${transientFailureProbes.findings.length} arm(s) — ${transientFailureProbes.findings
        .map((f) => `${f.traitName}:${f.from}+${f.event}->${f.to} — ${f.reason}`)
        .join('; ')}`,
      evidence: { frameIndices: [] },
    };
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
    // `--trait` scope: the coverage denominator counts only the selected
    // trait(s) — an unscoped run (`traitScope === null`) keeps every trait.
    if (traitScope !== null && !traitScope.includes(trait.name)) continue;
    for (const t of trait.stateMachine?.transitions ?? []) {
      schemaTransitions += 1;
      schemaTransitionKeys.push(`${trait.name}:${t.from}+${t.event}->${t.to}`);
    }
  }

  let frontierSummary: ReportShape['frontier'];
  if (frontier) {
    const importedTransitionsSkipped = frontierSkipped.reduce((sum, s) => sum + s.transitions, 0);
    frontierSummary = {
      authoredTraits: walkTraits.length - frontierSkipped.length,
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
    effectEmittedByTrait,
    ...(frontierSummary !== undefined && { frontier: frontierSummary }),
    ...(walkBudgetEntries.length > 0 && { walkBudget: walkBudgetEntries }),
    ...(traitScope !== null && { traits: traitScope }),
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
 *
 * Never applied to a step whose own transition is a `persist create`: a
 * `(set @entity.id ?id) … (persist create X @entity)` lifecycle binds the id
 * it mints, and seeding an existing row's id there defeats the create
 * (`Almadar_Runtime_Gaps.md` R-DATAMUTATION-CREATE-SEED-COLLISION).
 */
function seedEntityIdIfBinding(
  step: ExtendedWalkStep,
  bindings: ReadonlyMap<string, EntityIdBindingSource> | undefined,
  seedRow: EntityRow | null,
  stepPersistKind: 'create' | 'update' | 'delete' | 'batch' | undefined,
): ExtendedWalkStep {
  if (bindings === undefined || seedRow === null || seedRow.id === undefined) return step;
  if (stepPersistKind === 'create') return step;
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

/**
 * RV item 25/27 (Verification_Runtime ledger item 25): `planWalk`'s base
 * "dispatch every declared transition once" step carries neither a
 * `viewerRequirement` nor a real seeded row id, so an access-policed or
 * by-id persist is denied there BY CONSTRUCTION — a spurious
 * `effect-failure-not-surfaced`/`effect-failure-unrouted` finding on a
 * transition `planDataMutationTests`'s OWN sibling step (SAME `(from,
 * event, to)`) already proves works with a real row/viewer. Rather than
 * re-deriving that analysis a second time, copy the already-computed
 * `viewerRequirement`/`establishesRow`/`bindRowFrom`/`unreachableRowReason`
 * fields from the matching data-mutation step onto the base step's own
 * `success`-variant — one owner (`planDataMutationTests`'s `planRowEstablishPreamble`
 * / `deriveViewerRequirement`), reused rather than reimplemented. Only the
 * `success` variant is touched: `malformed`/`guard-fail` are validator/guard
 * rejection tests whose effects never run, so a viewer/row context has
 * nothing to attach to. Mutates `baseSteps` in place.
 */
function attachRowContextFromDataMutation(
  baseSteps: ExtendedWalkStep[],
  extensionSteps: ReadonlyArray<ExtendedWalkStep>,
): void {
  const dataMutationByKey = new Map<string, ExtendedWalkStep>();
  for (const step of extensionSteps) {
    if (step.testKind !== 'data-mutation') continue;
    dataMutationByKey.set(`${step.from}+${step.event}->${step.to}`, step);
  }
  if (dataMutationByKey.size === 0) return;

  for (const step of baseSteps) {
    if (step.payloadCase !== 'success') continue;
    const match = dataMutationByKey.get(`${step.from}+${step.event}->${step.to}`);
    if (match === undefined) continue;
    if (match.viewerRequirement !== undefined) step.viewerRequirement = match.viewerRequirement;
    if (match.establishesRow !== undefined) step.establishesRow = match.establishesRow;
    if (match.bindRowFrom !== undefined) step.bindRowFrom = match.bindRowFrom;
    if (match.unreachableRowReason !== undefined) step.unreachableRowReason = match.unreachableRowReason;
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

