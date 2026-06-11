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

export function planReplayTo(
  input: PlanReplayInput,
  entityFieldsByName: Record<string, EntityFieldDef[]> = {},
): ExtendedWalkStep[] {
  const { trait, targetState } = input;

  if (targetState === trait.initialState) return [];

  // Exclude effect-emitted events from the replay graph: they are fired by an
  // effect's outcome (a fetch's success/failure callback), not by a manual
  // dispatch, so a reconcile hop on one can't be driven deterministically and
  // diverges. A target reachable ONLY through such a hop (e.g. an `error`
  // state behind a fetch-failure event) is treated as unreachable — the walk
  // skips the diverging preamble rather than failing on an undrivable path.
  const path = bfsShortestPath(
    trait.transitions,
    trait.initialState,
    targetState,
    trait.effectEmittedEvents,
  );
  if (path === null) return [];

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
    };
  });
}

/**
 * BFS shortest path from `source` to `target`. Skips INIT events from
 * the source (those are auto-fired by the runtime, not walk-fired) and
 * wildcard-source pseudostates. Returns null when target is unreachable.
 */
function bfsShortestPath(
  transitions: ReadonlyArray<EdgeWalkTransition>,
  source: string,
  target: string,
  excludeEvents?: ReadonlySet<string>,
): ReadonlyArray<ReplayHop> | null {
  if (source === target) return [];

  // Build adjacency list from filtered transitions.
  const adjacency = new Map<string, ReadonlyArray<EdgeWalkTransition>>();
  for (const t of transitions) {
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
      if (edge.to === target) return newPath;
      visited.add(edge.to);
      queue.push({ state: edge.to, path: newPath });
    }
  }

  return null;
}
