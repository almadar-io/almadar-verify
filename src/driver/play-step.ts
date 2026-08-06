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

import type { EffectTrace, EventLogEntry, EventPayload, SExpr } from '@almadar/core';
import type { TraitWalkConfig } from '../engine/types.js';
import type { ExtendedWalkStep } from '../planner/types.js';
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
  /** Guard evaluator hook, forwarded to {@link createFakeDriver}. */
  evaluateGuard?: (guard: SExpr, ctx: { traitName: string; event: string; payload: EventPayload }) => boolean;
}

export interface PlayCircuitStepResult {
  trait: string;
  event: string;
  /**
   * A guard-fail always means no transition, even when `frame.accepted`
   * can't tell (a self-loop's `from === to` makes "state held" and
   * "state advanced" look identical from the outside).
   */
  transitionFired: boolean;
  guard: 'pass' | 'fail' | 'none';
  state: { before: string | null; after: string | null };
  effects: ReadonlyArray<EffectTrace>;
  emitted: ReadonlyArray<EventLogEntry>;
}

/**
 * Play one step on `target`. Throws when the trait declares no
 * `from --event-->` transition (caller resolves the trait first — see
 * `extractTraitWalkConfigs`).
 */
export async function playCircuitStep(
  target: TraitWalkConfig,
  input: PlayCircuitStepInput,
): Promise<PlayCircuitStepResult> {
  const transition = target.transitions.find((t) => t.from === input.from && t.event === input.event);
  if (!transition) {
    throw new Error(`Trait "${target.traitName}" has no transition ${input.from} --${input.event}-->.`);
  }

  const to = input.expectTo ?? transition.to;
  const payload = input.payload ?? {};

  // Boxed: a bare `let` gets over-narrowed by TS control-flow analysis
  // across the `tick()` await (it can't see the closure runs during that
  // await, so it treats the post-await read as still `none`).
  const guardBox: { verdict: 'pass' | 'fail' | 'none' } = { verdict: 'none' };
  const { driver, runtime } = createFakeDriver([target], {
    ...(input.evaluateGuard
      ? {
          evaluateGuard: (guard, ctx) => {
            const passed = input.evaluateGuard?.(guard, ctx) ?? true;
            guardBox.verdict = passed ? 'pass' : 'fail';
            return passed;
          },
        }
      : {}),
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

  return {
    trait: target.traitName,
    event: input.event,
    transitionFired: guardBox.verdict === 'fail' ? false : frame.accepted,
    guard: guardBox.verdict,
    state: { before: frame.stateBefore, after: frame.stateAfter },
    effects: frame.effectResults,
    emitted: frame.eventLogDelta.added,
  };
}
