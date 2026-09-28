/**
 * playCircuitStep — play exactly one circuit step (Event → Guard →
 * Transition → Effects) against a {@link TraitWalkConfig} in-process: no
 * server, no browser, milliseconds.
 *
 * This is the canonical single-step play composition shared by the
 * almadar-tools `play_transition` MCP probe and the eval-spec circuit
 * helpers (`tools/orbital-agent-cli/src/evals/specs/_helpers/`). Guard
 * truth is the CALLER's business: pass `evaluateGuard` (typically closing
 * over `@almadar/evaluator`'s `evaluateGuard` with `@payload`/`@entity`/
 * `@config` bindings) and the result's `guard` verdict is real; omit it
 * and dispatch is unconditional (`guard: 'none'`), matching
 * {@link createFakeDriver}'s default.
 */

import type { CircuitStepResult, Effect, EffectTrace, EventPayload, GuardEvaluation, SExpr } from '@almadar/core';
import type { TraitWalkConfig } from '../engine/types.js';
import type { ExtendedWalkStep } from '../planner/types.js';
import type { GuardVerdict } from './circuit-hooks.js';
import { createFakeDriver, type FakeDriverContext } from './impls/fake.js';
import { tick } from './tick.js';

export interface PlayCircuitStepInput {
  /** State to play the transition from. */
  from: string;
  /** Event to play. */
  event: string;
  /** Expected state after the transition. Defaults to the transition's own declared target. */
  expectTo?: string;
  /** Event payload — also the `@payload` binding a guard hook receives. */
  payload?: EventPayload;
  /** Guard evaluator hook, forwarded to {@link createFakeDriver}. A {@link GuardVerdict} also records the guard's trace in the result. */
  evaluateGuard?: (guard: SExpr, ctx: { traitName: string; event: string; payload: EventPayload }) => boolean | GuardVerdict;
  /**
   * Effect executor hook, forwarded to {@link createFakeDriver}. When the
   * fired arm declares effects, this runs them and reports what happened
   * — omit it to play the state machine only (effects/emitted then carry
   * just the input event echo, the pre-existing behavior).
   */
  executeEffects?: (
    effects: Effect[],
    ctx: { traitName: string; event: string; payload: EventPayload },
  ) => { effects: EffectTrace[]; emitted: Array<{ event: string; payload?: EventPayload }> };
}

export type PlayCircuitStepResult = CircuitStepResult;

/**
 * Play one step on `target`. Throws when the trait declares no
 * `from --event-->` transition (caller resolves the trait first — see
 * `extractTraitWalkConfigs`).
 */
export async function playCircuitStep(
  target: TraitWalkConfig,
  input: PlayCircuitStepInput,
): Promise<PlayCircuitStepResult> {
  const arms = target.transitions.filter((t) => t.from === input.from && t.event === input.event);
  if (arms.length === 0) {
    throw new Error(`Trait "${target.traitName}" has no transition ${input.from} --${input.event}-->.`);
  }

  const payload = input.payload ?? {};

  // Arm selection mirrors StateMachineCore.processEvent: candidates in
  // declaration order, first unguarded arm or first passing guard wins, a
  // guard error counts as a fail and falls through. Playing only arms[0]
  // (the old behavior) reported a false "blocked" for the standard
  // guarded-arm → unguarded-fallback pattern.
  const verdictOf = (guard: SExpr, ctx: { traitName: string; event: string; payload: EventPayload }): GuardVerdict | boolean =>
    input.evaluateGuard ? input.evaluateGuard(guard, ctx) : true;
  const guards: GuardEvaluation[] = [];
  let transition = arms[arms.length - 1];
  let firedArm: number | undefined;
  let selection: 'pass' | 'fail' | 'none' = 'fail';
  for (const [index, arm] of arms.entries()) {
    if (arm.guard === undefined || arm.guard === null) {
      transition = arm;
      firedArm = index;
      selection = 'none';
      break;
    }
    let passed = true;
    if (input.evaluateGuard) {
      try {
        const verdict = verdictOf(arm.guard, { traitName: target.traitName, event: input.event, payload });
        if (typeof verdict === 'boolean') passed = verdict;
        else {
          passed = verdict.passed;
          guards.push({ ...verdict, arm: index, guard: arm.guard });
        }
      } catch {
        passed = false;
      }
    }
    if (passed) {
      transition = arm;
      firedArm = index;
      selection = input.evaluateGuard ? 'pass' : 'none';
      break;
    }
  }

  const to = input.expectTo ?? transition.to;

  const { driver, runtime } = createFakeDriver([target], {
    ...(input.evaluateGuard
      ? {
          evaluateGuard: (guard, ctx) => {
            const verdict = verdictOf(guard, ctx);
            if (typeof verdict === 'boolean') return verdict;
            if (verdict.error !== undefined) throw new Error(verdict.error);
            return verdict.passed;
          },
        }
      : {}),
    ...(input.executeEffects ? { executeEffects: input.executeEffects } : {}),
  });
  runtime.setState(target.traitName, input.from);

  const step: ExtendedWalkStep = {
    from: input.from,
    event: input.event,
    to,
    guardCase: null,
    payload,
    isRepositioning: false,
    triggerKind: 'bus',
    coverageKey: `${target.traitName}:${input.from}+${input.event}->${to}`,
    traitName: target.traitName,
  };
  const ctx: FakeDriverContext = { outputDir: '', trait: target, runtime };
  const frame = await tick(driver, ctx, null, step);

  // `selection` (the pre-pass verdict for the CHOSEN arm) is authoritative:
  // guardBox records the LAST hook call during the tick, which for a
  // guarded-arm → unguarded-fallback dispatch is the FAILED first arm even
  // though the fallback fired. Without a chosen arm (all guards failed),
  // nothing fires regardless of what the driver accepted.
  return {
    trait: target.traitName,
    event: input.event,
    transitionFired: selection === 'fail' ? false : frame.accepted,
    guard: selection,
    ...(firedArm !== undefined ? { firedArm } : {}),
    state: { before: frame.stateBefore, after: frame.stateAfter },
    effects: frame.effectResults,
    emitted: frame.eventLogDelta.added,
    ...(guards.length > 0 ? { guards } : {}),
  };
}
