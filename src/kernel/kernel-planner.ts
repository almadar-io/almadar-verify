/**
 * The kernel as the verifier's one planner. `@almadar/kernel` (orbital-core's planner and verdict logic as wasm)
 * answers what to fire and what to expect; the browser driver in this package fires it and observes.
 *
 * @packageDocumentation
 */

import type { OrbitalSchema, SExpr } from '@almadar/core';
import type {
  AffordanceQuery,
  AffordanceStep,
  Credit,
  CreditStep,
  Expectation,
  Observation,
  PlanOptions,
  PlanOutcome,
  PreambleEvent,
  PropositionObservation,
  PropositionVerdict,
  StepWire,
  TransientOutcome,
  TransientQuery,
  VerdictWire,
} from '@almadar/core/kernel-wire';

/** The wasm exports the planner calls: JSON strings in, JSON strings out (`@almadar/kernel`). */
export interface KernelExports {
  verifyPlan(programJson: string, optionsJson: string): string | Promise<string>;
  verifyAffordance(programJson: string, queryJson: string, optionsJson: string): string | Promise<string>;
  verifyTransientProbe(programJson: string, queryJson: string, optionsJson: string): string | Promise<string>;
  verifyExpect(stepJson: string): string | Promise<string>;
  verifyJudge(expectationJson: string, observationJson: string): string | Promise<string>;
  verifyProposition(ensuresJson: string, observationJson: string): string | Promise<string>;
  verifyCredit(stepsJson: string): string | Promise<string>;
  verifyReplay(programJson: string, queryJson: string, optionsJson: string): string | Promise<string>;
}

/** The exports a kernel answers over HTTP: the playground server holds the wasm and a browser host calls it. */
export type KernelOp = keyof KernelExports;

export const KERNEL_OPS: ReadonlyArray<KernelOp> = ['verifyPlan', 'verifyAffordance', 'verifyTransientProbe', 'verifyExpect', 'verifyJudge', 'verifyProposition', 'verifyCredit', 'verifyReplay'];

/** A remote kernel: every export is one `POST url` with `{ op, args }`, answered `{ result }`. */
export function createRemoteKernelExports(url: string, post: typeof fetch = fetch): KernelExports {
  const call = (op: KernelOp) => async (...args: string[]): Promise<string> => {
    const response = await post(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, args }) });
    if (!response.ok) throw new Error(`${op}: ${response.status} ${await response.text()}`);
    return (await response.json() as { result: string }).result;
  };
  return {
    verifyPlan: call('verifyPlan'),
    verifyAffordance: call('verifyAffordance'),
    verifyTransientProbe: call('verifyTransientProbe'),
    verifyExpect: call('verifyExpect'),
    verifyJudge: call('verifyJudge'),
    verifyProposition: call('verifyProposition'),
    verifyCredit: call('verifyCredit'),
    verifyReplay: call('verifyReplay'),
  };
}

/** A planned program: the `planned` arm of {@link PlanOutcome}. */
export type PlannedProgram = Extract<PlanOutcome, { outcome: 'planned' }>;

/** The kernel's planner and verdict logic, bound to one installed language. */
export interface KernelPlanner {
  plan(program: OrbitalSchema, options?: PlanOptions): Promise<PlannedProgram>;
  affordance(program: OrbitalSchema, query: AffordanceQuery, options?: PlanOptions): Promise<AffordanceStep | null>;
  transientProbe(program: OrbitalSchema, query: TransientQuery, options?: PlanOptions): Promise<TransientOutcome | null>;
  expect(step: StepWire): Promise<Expectation>;
  judge(expectation: Expectation, observation: Observation): Promise<VerdictWire>;
  /** A fired transition's `@ensures` judged on one run: `@entity` after its effects, `@fromEntity` before them. */
  proposition(ensures: ReadonlyArray<SExpr>, observation: PropositionObservation): Promise<PropositionVerdict>;
  credit(steps: ReadonlyArray<CreditStep>): Promise<Credit[]>;
  /** The hops that place a fresh machine of `trait` in `state`; `null` when the trait is unknown or the state unreachable. */
  replay(program: OrbitalSchema, trait: string, state: string, options?: PlanOptions): Promise<PreambleEvent[] | null>;
}

/** The kernel refused a program or an input; the typed failure is `outcome`. */
export class KernelPlanRefused extends Error {
  constructor(readonly outcome: Extract<PlanOutcome, { outcome: 'refused' }>) {
    super(`the kernel refused the program: ${outcome.failure.kind}`);
  }
}

/** Bind the planner to an initialised kernel whose language bundle is installed. */
export function createKernelPlanner(kernel: KernelExports): KernelPlanner {
  const optionsJson = (options: PlanOptions | undefined): string => (options === undefined ? '' : JSON.stringify(options));
  return {
    async plan(program, options) {
      const outcome = JSON.parse(await kernel.verifyPlan(JSON.stringify(program), optionsJson(options))) as PlanOutcome;
      if (outcome.outcome === 'refused') throw new KernelPlanRefused(outcome);
      return outcome;
    },
    async affordance(program, query, options) {
      return JSON.parse(await kernel.verifyAffordance(JSON.stringify(program), JSON.stringify(query), optionsJson(options))) as AffordanceStep | null;
    },
    async transientProbe(program, query, options) {
      return JSON.parse(await kernel.verifyTransientProbe(JSON.stringify(program), JSON.stringify(query), optionsJson(options))) as TransientOutcome | null;
    },
    async expect(step) {
      return JSON.parse(await kernel.verifyExpect(JSON.stringify(step))) as Expectation;
    },
    async judge(expectation, observation) {
      return JSON.parse(await kernel.verifyJudge(JSON.stringify(expectation), JSON.stringify(observation))) as VerdictWire;
    },
    async proposition(ensures, observation) {
      return JSON.parse(await kernel.verifyProposition(JSON.stringify(ensures), JSON.stringify(observation))) as PropositionVerdict;
    },
    async credit(steps) {
      return JSON.parse(await kernel.verifyCredit(JSON.stringify(steps))) as Credit[];
    },
    async replay(program, trait, state, options) {
      return JSON.parse(await kernel.verifyReplay(JSON.stringify(program), JSON.stringify({ trait, state }), optionsJson(options))) as PreambleEvent[] | null;
    },
  };
}
