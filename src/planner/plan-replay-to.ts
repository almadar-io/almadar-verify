/**
 * `planReplayTo` — pure planner that produces the steps needed to reach
 * a target state from the initial state.
 *
 * Inline BFS shortest path over the trait's transitions. We don't reuse
 * `buildReplayPaths` from `@almadar/core` because that helper requires
 * `ReplayTransition` (which carries render-effect / payload-schema
 * metadata only the compiled-shell consumer has). The planner's input
 * is just `EdgeWalkTransition[]` from `TraitWalkConfig`, so we run the
 * graph BFS directly. Each step is decorated with `triggerKind: 'replay'`.
 *
 * Pure.
 *
 * @packageDocumentation
 */

import { buildGuardPayloads, type EdgeWalkTransition, type EventPayload } from '@almadar/core';
import type { EntityFieldDef } from '../browser/interaction.js';
import type { ExtendedWalkStep, PlanReplayInput } from './types.js';
import { synthesizeSuccessPayload } from './internal/payload-synth.js';
import { transientClosure } from './internal/transient-closure.js';

/**
 * One hop in a replay path. Carries the originating `EdgeWalkTransition`
 * so the step mapper can read its guard metadata — a hop reachable only
 * through a guarded edge needs the guard's `pass` payload merged in, or
 * the replay dispatch is rejected and the `from`-state precondition for
 * the real step is never reached.
 */
interface ReplayHop {
  from: string;
  event: string;
  to: string;
  edge: EdgeWalkTransition;
}

interface QueueNode {
  state: string;
  path: ReadonlyArray<ReplayHop>;
}

/**
 * Returns:
 *  - `[]` — precondition already satisfied with ZERO dispatches: either
 *    `targetState` is the initial state itself, or it's already within
 *    the initial state's own transient closure (std-data-erasure's
 *    `execScanning`, reached from `idle` purely by a tick-fired
 *    `ExecScanLoaded` — no manually-dispatchable edge sits between them
 *    at all). The caller must treat this as "proceed", not "unreachable".
 *  - `null` — genuinely unreachable: no dispatchable hop's closure ever
 *    reaches `targetState`. The caller should skip the dependent step
 *    rather than dispatch it from a stale state.
 *  - non-empty array — the hop chain to dispatch.
 */
export function planReplayTo(
  input: PlanReplayInput,
  entityFieldsByName: Record<string, EntityFieldDef[]> = {},
): ExtendedWalkStep[] | null {
  const { trait, targetState } = input;

  if (targetState === trait.initialState) return [];

  // Exclude effect-emitted events from the replay graph as HOPS: they are
  // fired by an effect's outcome (a fetch's success/failure callback), not
  // by a manual dispatch, so a reconcile hop can't dispatch one
  // deterministically. But a target reachable ONLY through such a
  // transition (e.g. `loading --Loaded--> reviewing`, `APPROVE`'s
  // precondition on std-approval-gate) isn't unreachable — the runtime
  // fires it automatically once a dispatchable hop lands on its source
  // state, the same transient-settle the direct-step / reconcile-hop
  // `acceptStates` closure already tolerates. `bfsShortestPath` checks the
  // landing state's closure against `targetState`, so a hop into `loading`
  // satisfies a target of `reviewing` without needing to traverse the
  // effect-emitted edge itself. It also checks the SOURCE's own closure
  // before taking any hop at all (std-data-erasure's `execScanning`).
  const path = bfsShortestPath(trait, trait.initialState, targetState);
  if (path === null) return null;

  return path.map((step) => {
    // Look up the event's declared payloadSchema so the replay
    // dispatch carries a valid payload — the API-boundary validator
    // (added in @almadar/runtime 4.x / @almadar/std-shell 7.x) rejects
    // empty `{}` for events with required fields, which used to make
    // every replay step that traverses such an event silently no-op,
    // leaving the trait in a non-`from` state by the time the main
    // planner step ran. Synthesizing here keeps the replay walk-back
    // observable AND honest.
    const eventDecl = trait.events?.find((e) => e.key === step.event);
    const synth = synthesizeSuccessPayload(
      eventDecl?.payloadSchema,
      trait.linkedEntity,
      entityFieldsByName,
    );
    // A hop reachable only through a GUARDED edge needs the guard's
    // `pass` payload merged in — else the replay dispatch is rejected
    // and the trait never reaches `step.from`, leaving the real step's
    // preamble unreachable. Mirrors core's `buildPayloadForEdge` guard
    // branch (state-machine/edge-walk.ts) and the `planWalk` pass case.
    const payload: EventPayload = step.edge.hasGuard && step.edge.guard !== undefined
      ? { ...synth, ...buildGuardPayloads(step.edge.guard).pass }
      : synth;
    // `step.to` may itself be transient (e.g. a fetch's `loading` landing
    // state auto-advances to `cached`/`error` the instant the mocked
    // effect resolves, often before the reconcile frame is read). The BFS
    // above already excludes effect-emitted events as edges, so `step.event`
    // is always a real (non-effect-emitted) dispatch — only the
    // closure-of-`to` case (planWalk's non-effect-emitted branch) applies
    // here. Mirrors planWalk's transition-into-a-transient-state handling
    // exactly so a reconcile hop is tolerated the same way a direct step is.
    const acceptStates = transientClosure(step.to, trait);
    return {
      from: step.from,
      event: step.event,
      to: step.to,
      guardCase: null,
      payload,
      isRepositioning: true,
      traitName: trait.traitName,
      triggerKind: 'replay',
      coverageKey: `${trait.traitName}:${step.from}+${step.event}->${step.to}[replay]`,
      ...(acceptStates.length > 1 && { acceptStates }),
    };
  });
}

/**
 * BFS shortest path from `source` to `target`. Skips INIT events from
 * the source (those are auto-fired by the runtime, not walk-fired),
 * wildcard-source pseudostates, and effect-emitted events as HOPS (a
 * reconcile step can't dispatch one deterministically). A landing state
 * satisfies `target` either literally or via its transient closure —
 * `loading --Loaded--> reviewing` means a hop landing on `loading`
 * reaches `reviewing` on its own once the mocked effect settles, so BFS
 * stops there instead of treating `reviewing` as unreachable. The SOURCE
 * itself is checked the same way before any hop is taken — a target
 * already in the source's own closure (std-data-erasure's `idle
 * --(tick)ExecScanLoaded--> execScanning`, no manually-dispatchable edge
 * in between at all) needs zero dispatches, not "unreachable". Returns
 * `[]` for that zero-hop case, `null` only when neither the target nor
 * its precondition is reachable by any manually-dispatchable hop.
 */
function bfsShortestPath(
  trait: PlanReplayInput['trait'],
  source: string,
  target: string,
): ReadonlyArray<ReplayHop> | null {
  if (source === target) return [];
  if (transientClosure(source, trait).includes(target)) return [];
  const excludeEvents = trait.effectEmittedEvents;

  // Build adjacency list from filtered transitions.
  const adjacency = new Map<string, ReadonlyArray<EdgeWalkTransition>>();
  for (const t of trait.transitions) {
    if (t.from === '*') continue;
    if (t.event === 'INIT' && t.from === source) continue;
    if (excludeEvents?.has(t.event) === true) continue;
    const list = adjacency.get(t.from);
    if (list === undefined) {
      adjacency.set(t.from, [t]);
    } else {
      adjacency.set(t.from, [...list, t]);
    }
  }

  const visited = new Set<string>([source]);
  const queue: QueueNode[] = [{ state: source, path: [] }];

  while (queue.length > 0) {
    const { state, path } = queue.shift() as QueueNode;
    const edges = adjacency.get(state) ?? [];
    for (const edge of edges) {
      if (visited.has(edge.to)) continue;
      const newPath = [...path, { from: state, event: edge.event, to: edge.to, edge }];
      if (edge.to === target || transientClosure(edge.to, trait).includes(target)) return newPath;
      visited.add(edge.to);
      queue.push({ state: edge.to, path: newPath });
    }
  }

  return null;
}
