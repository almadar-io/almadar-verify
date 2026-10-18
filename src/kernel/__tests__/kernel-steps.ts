import type { OrbitalSchema } from '@almadar/core';
import type { PlanOutcome } from '@almadar/core/kernel-wire';
import { dataMutationSteps } from '../adapt.js';
import type { PlannedProgram } from '../kernel-planner.js';
import { loadKernelExports } from '../load-node.js';
import type { ExtendedWalkStep } from '../../planner/types.js';

const exports = loadKernelExports(process.cwd());

/** The kernel's plan of a program, synchronously (the node exports are synchronous). */
export function kernelPlan(program: OrbitalSchema): PlannedProgram {
  const outcome = JSON.parse(exports.verifyPlan(JSON.stringify(program), '') as string) as PlanOutcome;
  if (outcome.outcome !== 'planned') throw new Error(`the kernel refused the program: ${outcome.failure.kind}`);
  return outcome;
}

/** The data-mutation steps the kernel plans, in the driver's step vocabulary. */
export function planDataMutationTests(program: OrbitalSchema): ExtendedWalkStep[] {
  return dataMutationSteps(kernelPlan(program));
}
