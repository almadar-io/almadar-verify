/**
 * The `evaluateGuard` + `executeEffects` hooks that make a
 * {@link playCircuitStep} real: guard and effects run through
 * `@almadar/evaluator` against one mutable entity row, no server. Each
 * evaluation is recorded as it runs (`evaluateTraced`), so a guard verdict
 * carries its trace and every `EffectTrace` carries `evalTrace`.
 */

import type { Effect, EffectTrace, EntityRow, EvalTrace, EventPayload, RuntimeValue, SExpr, TraitConfig } from '@almadar/core';
import { isEventPayloadValue } from '@almadar/core';
import { createEffectContext, createMinimalContext, evaluateTraced } from '@almadar/evaluator';
import type { EvaluationContext } from '@almadar/evaluator';

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
  const baseContext = (payload: EventPayload): EvaluationContext => {
    const ctx = createMinimalContext(entityRow, payload, fromState);
    if (config) ctx.config = config;
    return ctx;
  };
  return {
    evaluateGuard: (guard, ctx) => {
      const run = evaluateTraced(guard, baseContext(ctx.payload));
      return run.error !== undefined
        ? { passed: false, trace: run.trace, error: run.error }
        : { passed: Boolean(run.value), trace: run.trace };
    },
    executeEffects: (effects, ctx) => {
      const emitted: Array<{ event: string; payload?: EventPayload }> = [];
      const effectCtx = createEffectContext(baseContext(ctx.payload), {
        mutateEntity: (changes) => Object.assign(entityRow, changes),
        emit: (event, payload) => {
          emitted.push({ event, payload: toEventPayload(payload) });
        },
      });
      const traces: EffectTrace[] = effects.map((effect) => {
        const type = effectKind(effect);
        const args = effectArgs(effect);
        // Every `Effect` variant is an S-expression at runtime; its variadic tuple arms are not structurally `SExpr` to TS.
        const run = evaluateTraced(effect as SExpr, effectCtx);
        return run.error !== undefined
          ? { type, args, status: 'failed', error: run.error, evalTrace: run.trace }
          : { type, args, status: 'executed', evalTrace: run.trace };
      });
      return { effects: traces, emitted };
    },
  };
}

/** The effect's operator head (`["set", ...]` → `"set"`), or `"unknown"` for a non-tuple effect. */
function effectKind(effect: Effect): string {
  return Array.isArray(effect) && typeof effect[0] === 'string' ? effect[0] : 'unknown';
}

/** The effect tuple's trailing args, for `EffectTrace.args`. */
function effectArgs(effect: Effect): SExpr[] {
  return Array.isArray(effect) ? (effect.slice(1) as SExpr[]) : [];
}

/** An `emit` payload narrowed to `EventPayload`; a non-object result reports no payload. */
function toEventPayload(value: RuntimeValue | undefined): EventPayload | undefined {
  return value !== undefined && isEventPayloadObject(value) ? value : undefined;
}

function isEventPayloadObject(value: RuntimeValue): value is EventPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date) && isEventPayloadValue(value);
}
