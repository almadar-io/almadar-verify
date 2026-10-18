/**
 * The `evaluateGuard` + `executeEffects` hooks that make a {@link playCircuitStep} real, against one mutable entity
 * row, no server. Both run on the kernel's evaluator: the guard through `evaluateGuards`, the effects through
 * `traceEffects`, which writes the row and raises events as `set` and `emit` do and reports an effect it has no host
 * for as `skipped`. Each evaluation is recorded as it runs, so a guard verdict carries its trace and every
 * `EffectTrace` carries `evalTrace`.
 */

import type { Effect, EffectTrace, EntityRow, EvalTrace, EventPayload, SExpr, TraitConfig } from '@almadar/core';
import { eventPayloadOf, kernelEvaluator, toWireValue } from '@almadar/core';
import type { EvalContextWire } from '@almadar/core/kernel-wire';

export interface GuardVerdict {
  passed: boolean;
  trace: EvalTrace;
  error?: string;
}

export interface CircuitHooks {
  evaluateGuard: (guard: SExpr, ctx: { traitName: string; event: string; payload: EventPayload }) => GuardVerdict;
  executeEffects: (
    effects: Effect[],
    ctx: { traitName: string; event: string; payload: EventPayload },
  ) => { effects: EffectTrace[]; emitted: Array<{ event: string; payload?: EventPayload }> };
}

/**
 * Hooks bound to one mutable entity row: a `set` inside a fired arm's
 * effects is visible to a later `set`/`emit` in the same list, and the
 * guard sees the entity exactly as given (before this step's effects run).
 */
export function createCircuitHooks(entityRow: EntityRow, fromState: string, config?: TraitConfig): CircuitHooks {
  const contextFor = (payload: EventPayload, entity: EntityRow): EvalContextWire => ({
    entity: toWireValue(entity),
    payload: toWireValue(payload),
    state: fromState,
    ...(config ? { config: toWireValue(config) } : {}),
  });
  return {
    evaluateGuard: (guard, ctx) => {
      const kernel = kernelEvaluator();
      const context = contextFor(ctx.payload, entityRow);
      const run = kernel.evaluateTraced(context, guard);
      if (run.outcome.kind === 'error') return { passed: false, trace: run.trace, error: run.outcome.message };
      const [verdict] = kernel.evaluateGuards(context, [guard]);
      return { passed: verdict.kind === 'value' && verdict.value, trace: run.trace };
    },
    executeEffects: (effects, ctx) => {
      // Every `Effect` variant is an S-expression at runtime; its variadic tuple arms are not structurally `SExpr` to TS.
      const run = kernelEvaluator().traceEffects(contextFor(ctx.payload, entityRow), effects as SExpr[]);
      for (const { field, value } of run.writes) Object.assign(entityRow, { [field]: value });
      const traces: EffectTrace[] = run.effects.map((trace) => ({
        type: trace.type,
        args: trace.args,
        status: trace.status,
        ...(trace.error !== undefined ? { error: trace.error } : {}),
        ...(trace.evalTrace !== undefined ? { evalTrace: trace.evalTrace } : {}),
      }));
      const emitted = run.emitted.map(({ event, payload }) => ({ event, payload: eventPayloadOf(payload) }));
      return { effects: traces, emitted };
    },
  };
}
