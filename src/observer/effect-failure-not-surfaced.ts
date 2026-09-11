/**
 * `assertEffectFailureNotSurfaced` — pure observer over `Frame[]` proving a
 * failed `persist`/`fetch`/`call-service` effect is never a silent dead
 * end.
 *
 * `assertDataMutation` (`assert-data-mutation.ts:74-86`) already reads the
 * same `outcome: 'denied' | 'failed'` record on `frame.effectResults` as
 * its canonical "the write did not happen" signal. That observer asks
 * whether the DATA moved; this one asks the rung-3 question §7 names —
 * whether a well-formed, individually-legal failure is CONSEQUENTIAL to the
 * person watching the screen. Two checks, in order:
 *
 *   (a) the effect's own declared `emit.failure` event actually landed in
 *       the bus event log (`frame.eventLogDelta.added`) within a bounded
 *       forward window — missing this (no declared route, or a declared
 *       route that never fired) is `effect-failure-unrouted`: the effect
 *       has no failure route at all.
 *   (b) a toast/alert mounted in the `toast` portal slot
 *       (`frame.domSnapshot.portals`) within the same window — missing
 *       this, with (a) satisfied, is `effect-failure-not-surfaced`: the
 *       failure fired on the bus but never reached the user.
 *
 * The forward window (`MAX_SURFACE_LOOKAHEAD`) mirrors
 * `assert-crud-flow.ts`'s `MAX_CASCADE_LOOKAHEAD` — the failure event's own
 * listener (the trait that opens the toast) is very often a DIFFERENT
 * trait than the one that ran the effect, so its handling frame can settle
 * one or two frames after the failing effect's own frame.
 *
 * A guard rejection is never an effect failure: the transition's effects
 * never ran, so `frame.effectResults` on a `guardCase === 'fail'` frame is
 * stale — the driver reads "the most recent transition trace" (see the
 * comment on `frame.effectResults` in `driver/tick.ts`), carried over from
 * the last transition that actually fired. Malformed-payload variants are
 * skipped for the same reason `assertPortalPerStep` skips them: the
 * validator rejects before any effect executes.
 *
 * @packageDocumentation
 */

import type { Effect, EffectTrace, OrbitalSchema, SExpr } from '@almadar/core';
import { isInlineTrait } from '@almadar/core';
import type { Frame } from '../frame/types.js';
import type { Verdict } from './types.js';

/** Forward-scan bound for the failure-event + toast checks. */
const MAX_SURFACE_LOOKAHEAD = 4;

const FAILABLE_EFFECT_TYPES: ReadonlySet<string> = new Set(['persist', 'fetch', 'call-service']);

interface EmitConfigLike {
  success?: string;
  failure?: string;
}

function emitConfigOf(node: readonly SExpr[]): EmitConfigLike | undefined {
  const last = node[node.length - 1];
  if (last === null || typeof last !== 'object' || Array.isArray(last)) return undefined;
  const emit = (last as Readonly<Record<string, SExpr>>)['emit'];
  if (emit === null || typeof emit !== 'object' || Array.isArray(emit)) return undefined;
  const e = emit as Readonly<Record<string, SExpr>>;
  return {
    success: typeof e['success'] === 'string' ? e['success'] : undefined,
    failure: typeof e['failure'] === 'string' ? e['failure'] : undefined,
  };
}

/** Whether S-expr tuple `node` (headed by a `persist`/`fetch`/`call-service`
 *  operator matching `trace.type`) is the specific effect that produced
 *  `trace` — matched by action + entity where the trace carries them
 *  (`call-service` carries neither, so any `call-service` node matches). */
function effectMatchesTrace(node: readonly SExpr[], trace: EffectTrace): boolean {
  const head = node[0];
  if (head === 'persist') {
    if (trace.action !== undefined && node[1] !== trace.action) return false;
    if (trace.entityName !== undefined && node[2] !== trace.entityName) return false;
    return true;
  }
  if (head === 'fetch') {
    if (trace.entityName !== undefined && node[1] !== trace.entityName) return false;
    return true;
  }
  return head === 'call-service';
}

/**
 * Find the declared `emit.failure` event for the specific effect that
 * produced `trace`, or `undefined` when no matching effect declares one —
 * whether because no effect matched at all, or the matched effect has no
 * failure route. Both mean the same thing to a caller: this failure has no
 * PROVABLE route out of the transition.
 */
function declaredFailureEventFor(
  effects: ReadonlyArray<Effect> | undefined,
  trace: EffectTrace,
): string | undefined {
  if (effects === undefined) return undefined;
  let found: string | undefined;
  let matched = false;
  const visit = (node: Effect | SExpr): void => {
    if (matched || !Array.isArray(node)) return;
    const nodes = node as readonly SExpr[];
    if (
      (nodes[0] === 'persist' || nodes[0] === 'fetch' || nodes[0] === 'call-service') &&
      nodes[0] === trace.type &&
      effectMatchesTrace(nodes, trace)
    ) {
      matched = true;
      found = emitConfigOf(nodes)?.failure;
      return;
    }
    for (const child of nodes) visit(child);
  };
  for (const eff of effects) visit(eff);
  return found;
}

/** Every transition on `traitName` in `orbital` matching `(from, event)` —
 *  more than one can share the pair when guarded branches split it. */
function transitionsFor(
  orbital: OrbitalSchema,
  traitName: string,
  from: string,
  event: string,
): ReadonlyArray<{ effects?: ReadonlyArray<Effect> }> {
  const out: Array<{ effects?: ReadonlyArray<Effect> }> = [];
  for (const orb of orbital.orbitals) {
    for (const traitRef of orb.traits ?? []) {
      if (!isInlineTrait(traitRef) || traitRef.name !== traitName) continue;
      for (const t of traitRef.stateMachine?.transitions ?? []) {
        if (t.from === from && t.event === event) out.push(t);
      }
    }
  }
  return out;
}

function toastMounted(frame: Frame): boolean {
  return frame.domSnapshot.portals.some((p) => p.slot === 'toast' && p.mounted && p.childCount > 0);
}

export function assertEffectFailureNotSurfaced(
  frames: ReadonlyArray<Frame>,
  orbital: OrbitalSchema,
): Verdict[] {
  const verdicts: Verdict[] = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    // Guard-fail: the transition's effects never ran — effectResults is a
    // stale carry-over from the last transition that actually fired.
    if (frame.cause.guardCase === 'fail') continue;
    // Malformed: the validator rejects before any effect executes.
    if (frame.cause.payloadCase === 'malformed') continue;

    for (const trace of frame.effectResults) {
      if (trace.outcome !== 'denied' && trace.outcome !== 'failed') continue;
      if (!FAILABLE_EFFECT_TYPES.has(trace.type)) continue;

      const transitions = transitionsFor(orbital, frame.cause.traitName, frame.cause.from, frame.cause.event);
      let failureEvent: string | undefined;
      for (const t of transitions) {
        failureEvent = declaredFailureEventFor(t.effects, trace);
        if (failureEvent !== undefined) break;
      }

      const label = `${frame.cause.traitName} ${frame.cause.event} — ${trace.type}`
        + `${trace.entityName ? ` ${trace.entityName}` : ''} ${trace.outcome}${trace.error ? `: ${trace.error}` : ''}`;

      if (failureEvent === undefined) {
        verdicts.push({
          passed: false,
          detail: `effect-failure-unrouted: ${label} — the effect declares no emit.failure route, `
            + `so the failure has no provable path out of the transition`,
          evidence: { frameIndices: [frame.index] },
        });
        continue;
      }

      const window = frames.slice(i, Math.min(frames.length, i + 1 + MAX_SURFACE_LOOKAHEAD));
      // The failure route lands in the server response cascade (the same
      // signal `assert-data-mutation` reads for success routes) before it
      // reaches the client bus log — accept either.
      const eventFired = window.some(
        (f) =>
          f.eventLogDelta.added.some((e) => e.type === failureEvent)
          || (f.serverResponse?.emittedEvents ?? []).includes(failureEvent),
      );
      if (!eventFired) {
        verdicts.push({
          passed: false,
          detail: `effect-failure-unrouted: ${label} — declared emit.failure '${failureEvent}' never appeared `
            + `in the event log within ${MAX_SURFACE_LOOKAHEAD} frame(s) of the failure`,
          evidence: { frameIndices: [frame.index] },
        });
        continue;
      }

      const toastSeen = window.some(toastMounted);
      if (!toastSeen) {
        verdicts.push({
          passed: false,
          detail: `effect-failure-not-surfaced: ${label} — '${failureEvent}' fired but no toast/alert mounted `
            + `in the "toast" slot within ${MAX_SURFACE_LOOKAHEAD} frame(s) — the failure never reached the user`,
          evidence: { frameIndices: [frame.index] },
        });
        continue;
      }

      verdicts.push({
        passed: true,
        detail: `effect-failure-not-surfaced: ${label} — '${failureEvent}' fired and a toast mounted `
          + `within the settle window`,
        evidence: { frameIndices: [frame.index] },
      });
    }
  }

  return verdicts;
}
