/**
 * stepVerdict — whether one played circuit step (`playCircuitStep`, the `play_transition` probe)
 * did what its planned walk step expects: the planned arm fired (or, for a guard-fail variant, was
 * rejected, whether or not a sibling arm fired instead), the planned state reached, and no effect
 * failing. A write the access policy denied is the policy working, not a failure. A `malformed`
 * (empty-payload) variant tests the event's payload validator, which a circuit step does not run,
 * so it is inconclusive. Shared by the Studio canvas and the pre-deploy gate.
 */
import type { CircuitStepResult } from '@almadar/core';
import type { PayloadCase } from '../planner/types.js';

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

export function stepVerdict(result: CircuitStepResult, expected: StepExpectation): StepVerdict {
  const arm = `${expected.from} --${expected.event}-->`;
  if (expected.payloadCase === 'malformed') {
    return { ok: true, inconclusive: true, detail: `${arm} was played with an empty payload, which the event's payload validator rejects before any guard; a circuit step does not run that validator.` };
  }
  const plannedFired = expected.arm !== undefined
    ? result.transitionFired && result.firedArm === expected.arm
    : result.transitionFired && result.guard !== 'fail';
  const tookPlannedBranch = expected.guardCase === 'fail' ? !plannedFired : plannedFired;
  if (expected.guardCase !== null && expected.guardSteerable === false && !tookPlannedBranch) {
    return { ok: true, inconclusive: true, detail: `The guard on ${arm} does not depend on the event payload, so its ${expected.guardCase} branch cannot be driven from here.` };
  }
  if (expected.guardCase === 'fail') {
    return !plannedFired ? { ok: true } : { ok: false, detail: `The guard on ${arm} was expected to fail, and it passed.` };
  }
  if (!plannedFired) {
    if (result.transitionFired) return { ok: false, detail: `The guard on ${arm} failed, so another arm (to "${result.state.after ?? ''}") fired.` };
    if (result.guard === 'fail') return { ok: false, detail: `The guard on ${arm} failed.` };
    return { ok: false, detail: `${arm} did not fire.` };
  }
  const broken = result.effects.find((e) => e.outcome !== 'denied' && (e.outcome === 'failed' || e.status === 'failed'));
  if (broken) return { ok: false, detail: `${arm} ran ${broken.type}, which failed${broken.error ? `: ${broken.error}` : ''}` };
  if (result.state.after !== expected.to) {
    return { ok: false, detail: `${arm} reached "${result.state.after ?? ''}", expected "${expected.to}".` };
  }
  return { ok: true };
}
