/**
 * `assertListensEdgeNeverFired` — the runtime twin of `wiring-lint.ts`'s
 * static `listens-source-never-emits`: proves a declared `listens {
 * Source.EVENT -> triggers }` route ACTUALLY DELIVERS over a live session,
 * not just that the source event is structurally producible somewhere.
 *
 * Modelled on `emit-payload-always-empty.ts`'s per-session tally: walk the
 * whole session's bus event log (`Frame.eventLogDelta.added`, accumulated
 * across every frame) and tally how many times the SOURCE event fired vs
 * how many times the LISTENING trait's OWN `triggers` transition was
 * observed firing (`Frame.runtimeSnapshot.transitions`, the same "server
 * cascade credit" signal `coverage.ts` already trusts). The source firing
 * at least twice with the route's `triggers` NEVER observed on the
 * listening trait is the live counterpart of "wired on paper, dead in
 * practice" — a route that structurally exists (the static lint is silent)
 * but never actually delivers this session (a same-tick ordering bug, a
 * dropped cross-orbital envelope, a stale `eventId`).
 *
 * The ≥2 threshold mirrors `emit-payload-always-empty`'s own reasoning: one
 * firing proves nothing about a pattern; a route that fired the source
 * repeatedly and NEVER once landed is the honest signal.
 *
 * @packageDocumentation
 */

import type { OrbitalSchema } from '@almadar/core';
import { isInlineTrait } from '@almadar/core';
import type { Frame } from '../frame/types.js';
import type { Verdict } from './types.js';

interface DeclaredListenEdge {
  listenerTrait: string;
  sourceEvent: string;
  triggers: string;
}

function declaredListenEdgesOf(schema: OrbitalSchema): DeclaredListenEdge[] {
  const out: DeclaredListenEdge[] = [];
  for (const orb of schema.orbitals) {
    for (const traitRef of orb.traits ?? []) {
      if (!isInlineTrait(traitRef)) continue;
      for (const listen of traitRef.listens ?? []) {
        if (typeof listen.event !== 'string' || listen.event.length === 0) continue;
        if (typeof listen.triggers !== 'string' || listen.triggers.length === 0) continue;
        out.push({ listenerTrait: traitRef.name, sourceEvent: listen.event, triggers: listen.triggers });
      }
    }
  }
  return out;
}

export function assertListensEdgeNeverFired(
  frames: ReadonlyArray<Frame>,
  orbital: OrbitalSchema,
): Verdict[] {
  const edges = declaredListenEdgesOf(orbital);
  if (edges.length === 0) return [];

  const sourceFireIndices = new Map<string, number[]>();
  for (const frame of frames) {
    for (const entry of frame.eventLogDelta.added) {
      const indices = sourceFireIndices.get(entry.type) ?? [];
      indices.push(frame.index);
      sourceFireIndices.set(entry.type, indices);
    }
  }

  const observedTriggerFires = new Set<string>();
  for (const frame of frames) {
    for (const tx of frame.runtimeSnapshot.transitions) {
      observedTriggerFires.add(`${tx.traitName}::${tx.event}`);
    }
  }

  const verdicts: Verdict[] = [];
  const reported = new Set<string>();
  for (const edge of edges) {
    const key = `${edge.listenerTrait} ${edge.sourceEvent} -> ${edge.triggers}`;
    if (reported.has(key)) continue;
    const fires = sourceFireIndices.get(edge.sourceEvent);
    if (fires === undefined || fires.length < 2) continue;
    if (observedTriggerFires.has(`${edge.listenerTrait}::${edge.triggers}`)) continue;
    reported.add(key);
    verdicts.push({
      passed: false,
      detail:
        `listens-edge-never-fired — ${edge.listenerTrait} listens '${edge.sourceEvent}' -> '${edge.triggers}'; ` +
        `the source fired ${fires.length} time(s) this session but '${edge.triggers}' was never observed firing ` +
        `on ${edge.listenerTrait} — wired on paper, dead in this session`,
      evidence: { frameIndices: fires },
    });
  }

  return verdicts;
}
