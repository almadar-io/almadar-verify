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

import type { EdgeWalkTransition } from '@almadar/core';
import type { EntityFieldDef } from '../browser/interaction.js';
import type { ExtendedWalkStep, PlanReplayInput } from './types.js';
import { synthesizeSuccessPayload } from './internal/payload-synth.js';

interface QueueNode {
  state: string;
  path: ReadonlyArray<{ from: string; event: string; to: string }>;
}

export function planReplayTo(
  input: PlanReplayInput,
  entityFieldsByName: Record<string, EntityFieldDef[]> = {},
): ExtendedWalkStep[] {
  const { trait, targetState } = input;

  if (targetState === trait.initialState) return [];

  const path = bfsShortestPath(trait.transitions, trait.initialState, targetState);
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
    const payload = synthesizeSuccessPayload(
      eventDecl?.payloadSchema,
      trait.linkedEntity,
      entityFieldsByName,
    );
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
): ReadonlyArray<{ from: string; event: string; to: string }> | null {
  if (source === target) return [];

  // Build adjacency list from filtered transitions.
  const adjacency = new Map<string, ReadonlyArray<EdgeWalkTransition>>();
  for (const t of transitions) {
    if (t.from === '*') continue;
    if (t.event === 'INIT' && t.from === source) continue;
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
      const newPath = [...path, { from: state, event: edge.event, to: edge.to }];
      if (edge.to === target) return newPath;
      visited.add(edge.to);
      queue.push({ state: edge.to, path: newPath });
    }
  }

  return null;
}
