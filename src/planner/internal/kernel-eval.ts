/**
 * The planner's evaluations, on the kernel's evaluator (`@almadar/core`'s installed `kernelEvaluator`): one value or one
 * guard verdict against a minimal context of an entity row, an event payload and a state.
 */

import type { EntityRow, EventPayload, SExpr } from '@almadar/core';
import { kernelEvaluator, toWireValue } from '@almadar/core';
import type { EvalContextWire } from '@almadar/core/kernel-wire';

function contextOf(entity: EntityRow, payload: EventPayload, state: string): EvalContextWire {
  return { entity: toWireValue(entity), payload: toWireValue(payload), state };
}

/** The expression's value; throws `KernelEvalError` when the evaluator rejects it. */
export function evaluateValue(expr: SExpr, entity: EntityRow, payload: EventPayload, state: string) {
  return kernelEvaluator().evaluate(contextOf(entity, payload, state), expr);
}

/** Whether the guard holds by the kernel's truthiness; throws `KernelEvalError` when the evaluator rejects it. */
export function guardPasses(guard: SExpr, entity: EntityRow, payload: EventPayload, state: string): boolean {
  const verdict = kernelEvaluator().evaluateGuard(contextOf(entity, payload, state), guard);
  if (verdict.kind === 'error') throw new Error(verdict.message);
  return verdict.value;
}
