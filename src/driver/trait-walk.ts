/**
 * walkTraitVerdict — play one trait's kernel-planned walk (`verifyPlan`) step by step through the engine the
 * `play_transition` probe wraps (`declaredEntityRow` + `createCircuitHooks` + `playCircuitStep`),
 * grade each step with the kernel's `verifyJudge`, and stop at the first red step. Each step starts from the
 * linked entity's first seeded row, as each canvas step does. Shared by the Studio canvas and the
 * pre-deploy gate.
 */
import type { CircuitStepResult, EntityRow, EventPayload, OrbitalSchema, TraitConfig } from '@almadar/core';
import type { Observation, ObservedEffect, StepWire, VerdictWire } from '@almadar/core/kernel-wire';
import { inconclusiveReason, walkStep, walkWire } from '../kernel/adapt.js';
import type { KernelPlanner } from '../kernel/kernel-planner.js';
import { extractTraitWalkConfigs } from '../planner/extract-trait-walk-configs.js';
import type { PayloadCase } from '../planner/types.js';
import { createCircuitHooks } from './circuit-hooks.js';
import { declaredEntityRow } from './declared-entity-row.js';
import { playCircuitStep, type PlayCircuitStepResult } from './play-step.js';

/** What a planned walk step expects of its played step. */
export interface StepExpectation {
  from: string;
  event: string;
  to: string;
  guardCase: 'pass' | 'fail' | null;
  /** The planner's `guardSteerable`: false when the payload cannot drive the guard's outcome. */
  guardSteerable?: boolean;
  /** The planned arm's position among the trait's `from --event-->` arms (`firedArm`'s numbering). */
  arm?: number;
  payloadCase?: PayloadCase;
}

export interface StepVerdict {
  ok: boolean;
  /** The step could not test what it planned (an unsteerable guard took the other branch). */
  inconclusive?: boolean;
  detail?: string;
}

export function stepExpectation(step: StepExpectation): StepExpectation {
  return {
    from: step.from,
    event: step.event,
    to: step.to,
    guardCase: step.guardCase,
    ...(step.guardSteerable !== undefined ? { guardSteerable: step.guardSteerable } : {}),
    ...(step.arm !== undefined ? { arm: step.arm } : {}),
    ...(step.payloadCase !== undefined ? { payloadCase: step.payloadCase } : {}),
  };
}

/** A played circuit step as the kernel's judge sees it. */
export function observationOf(result: CircuitStepResult): Observation {
  return {
    stateBefore: result.state.before ?? '',
    stateAfter: result.state.after ?? '',
    ...(result.firedArm !== undefined ? { firedArm: result.firedArm } : {}),
    effects: result.effects.map((effect): ObservedEffect => {
      const failed = effect.outcome !== 'denied' && (effect.outcome === 'failed' || effect.status === 'failed');
      return {
        outcome: failed ? 'failed' : effect.status === 'executed' ? 'executed' : 'noop',
        ...(effect.routed !== undefined ? { routed: effect.routed } : {}),
      };
    }),
  };
}

/** The kernel's verdict on a played step, with the finding the Studio canvas and the gate show. */
export function stepVerdictOf(step: Pick<StepWire, 'from' | 'event' | 'to' | 'guardCase' | 'armConflict'>, result: CircuitStepResult, verdict: VerdictWire): StepVerdict {
  const arm = `${step.from} --${step.event}-->`;
  const reason = verdict.reason;
  switch (reason.kind) {
    case 'reached':
    case 'held-under-guard':
    case 'guard-rejected':
      return { ok: true };
    case 'arm-unsolved':
      return { ok: true, inconclusive: true, detail: step.armConflict !== undefined ? inconclusiveReason(step, step.armConflict) : `${arm} ${step.to}: no payload was solved for this arm` };
    case 'guard-unsteerable':
      return { ok: true, inconclusive: true, detail: `The guard on ${arm} does not depend on the event payload, so its ${step.guardCase ?? 'pass'} branch cannot be driven from here.` };
    case 'payload-validator-not-run':
      return { ok: true, inconclusive: true, detail: `${arm} was played with an empty payload, which the event's payload validator rejects before any guard; a circuit step does not run that validator.` };
    case 'precondition-unproven':
      return { ok: true, inconclusive: true, detail: `${arm} did not do what was planned, and its precondition is not shown to hold.` };
    case 'preamble-missed':
      return { ok: true, inconclusive: true, detail: `${arm} could not be played from "${step.from}": the machine was in "${reason.actual}".` };
    case 'not-driven':
      return { ok: true, inconclusive: true, detail: `${arm} is an http reply route, which a circuit step does not drive.` };
    case 'guard-accepted':
      return { ok: false, detail: `The guard on ${arm} was expected to fail, and it passed.` };
    case 'arm-not-fired':
      if (result.transitionFired) return { ok: false, detail: `The guard on ${arm} failed, so another arm (to "${result.state.after ?? ''}") fired.` };
      return { ok: false, detail: result.guard === 'fail' ? `The guard on ${arm} failed.` : `${arm} did not fire.` };
    case 'effect-failed': {
      const broken = result.effects.find((e) => e.outcome !== 'denied' && e.routed === undefined && (e.outcome === 'failed' || e.status === 'failed'));
      return { ok: false, detail: `${arm} ran ${broken?.type ?? 'an effect'}, which failed${broken?.error ? `: ${broken.error}` : ''}` };
    }
    case 'wrong-state':
      if (!result.transitionFired) return { ok: false, detail: `${arm} did not fire.` };
      return { ok: false, detail: `${arm} reached "${reason.actual}", expected "${step.to}".` };
  }
}

export interface TraitWalkOptions {
  /** Seeded rows by entity (`buildMockData`); each step's `@entity` is the linked entity's first
   *  row, layered over its declared defaults. */
  mockData?: Readonly<Record<string, readonly EntityRow[]>>;
  config?: TraitConfig;
}

export interface WalkedStep extends StepExpectation {
  payload: EventPayload;
  result: PlayCircuitStepResult;
  verdict: StepVerdict;
}

export interface TraitWalkVerdict {
  trait: string;
  /** `inconclusive`: no step is red, but a planned arm could not be shown to fire (`ExtendedWalkStep.inconclusive`); never a pass. */
  status: 'pass' | 'fail' | 'inconclusive';
  /** The first red step's finding, or the first inconclusive arm's reason. */
  detail?: string;
  steps: WalkedStep[];
}

export async function walkTraitVerdict(kernel: KernelPlanner, schema: OrbitalSchema, traitName: string, options: TraitWalkOptions = {}): Promise<TraitWalkVerdict> {
  const target = extractTraitWalkConfigs(schema).find((c) => c.traitName === traitName);
  if (!target) throw new Error(`No trait named "${traitName}" in this schema.`);
  const planned = await kernel.plan(schema);
  const seeded = target.linkedEntity !== undefined ? options.mockData?.[target.linkedEntity]?.[0] : undefined;
  const steps: WalkedStep[] = [];
  let inconclusive: string | undefined;
  for (const wire of walkWire(planned, traitName)) {
    const plannedStep = walkStep(wire);
    const expected = stepExpectation(plannedStep);
    const payload: EventPayload = plannedStep.payload ?? {};
    const row = declaredEntityRow(schema, target.linkedEntity, seeded);
    const result = await playCircuitStep(target, {
      from: plannedStep.from,
      event: plannedStep.event,
      payload,
      ...createCircuitHooks(row, plannedStep.from, options.config),
    });
    const judged = await kernel.judge(await kernel.expect(wire), observationOf(result));
    const verdict = stepVerdictOf(wire, result, judged);
    if (inconclusive === undefined && judged.reason.kind === 'arm-unsolved' && verdict.detail !== undefined) inconclusive = verdict.detail;
    steps.push({ ...expected, payload, result, verdict });
    if (!verdict.ok) return { trait: traitName, status: 'fail', ...(verdict.detail ? { detail: verdict.detail } : {}), steps };
  }
  if (inconclusive !== undefined) return { trait: traitName, status: 'inconclusive', detail: inconclusive, steps };
  return { trait: traitName, status: 'pass', steps };
}
