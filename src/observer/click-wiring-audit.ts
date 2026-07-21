/**
 * `auditListens` — static audit of an orbital's `emits` → `listens` wiring.
 *
 * A trait's `emits {}` contract declares events it broadcasts for other
 * traits to react to. Each declared emit is "wired" when either the
 * emitting trait itself reacts to it (a self-transition on the same event
 * key) or some trait's `listens {}` block subscribes to it. An emit with
 * neither is a dead broadcast — the fix is always a `listens` line on the
 * consuming trait, never a heuristic guess.
 *
 * Events emitted by a `fetch`/`persist` effect's `emit: { success, failure }`
 * option (see `collectEffectEmittedEvents`) are excluded: those are
 * data-lifecycle notifications the same transition's transient closure
 * already consumes, never a user affordance, so the audit only covers
 * genuine user/action-facing emits ("button-ish emitters").
 *
 * `buildTraitTransitions` / `buildDeclaredListeners` are shared with
 * `assertClickNoListener` (the runtime-frame counterpart of this same
 * self-transition / declared-listens check) — extracted here so both stay
 * on one definition.
 *
 * @packageDocumentation
 */

import type { OrbitalSchema, TraitEventListener } from '@almadar/core';
import { collectEffectEmittedEvents } from '../planner/internal/effect-emits.js';

/** For each trait, the set of events its own state machine transitions on. */
export function buildTraitTransitions(orbital: OrbitalSchema): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const orb of orbital.orbitals) {
    for (const traitRef of orb.traits) {
      if (typeof traitRef !== 'object' || !('name' in traitRef)) continue;
      const traitName = traitRef.name as string;
      const events = new Set<string>();
      if (
        'stateMachine' in traitRef &&
        traitRef.stateMachine &&
        'transitions' in traitRef.stateMachine &&
        Array.isArray(traitRef.stateMachine.transitions)
      ) {
        for (const trans of traitRef.stateMachine.transitions) {
          if (trans && typeof trans === 'object' && 'event' in trans) {
            events.add((trans as { event: string }).event);
          }
        }
      }
      map.set(traitName, events);
    }
  }
  return map;
}

/** For each event, the set of emitter trait names some trait's `listens`
 *  block subscribes to. `'*'` means any source is accepted. */
export function buildDeclaredListeners(orbital: OrbitalSchema): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const orb of orbital.orbitals) {
    for (const traitRef of orb.traits) {
      if (typeof traitRef !== 'object' || !('name' in traitRef)) continue;
      const listens = (traitRef as { listens?: ReadonlyArray<TraitEventListener> }).listens ?? [];
      for (const listener of listens) {
        if (typeof listener.event !== 'string') continue;
        const sources = map.get(listener.event) ?? new Set<string>();
        const source = listener.source;
        if (source !== undefined && 'kind' in source && source.kind === 'trait' && typeof source.trait === 'string') {
          sources.add(source.trait);
        } else {
          sources.add('*');
        }
        map.set(listener.event, sources);
      }
    }
  }
  return map;
}

/** One trait's declared `emits` event, and whether anything reacts to it. */
export interface ListensAuditEmitter {
  trait: string;
  event: string;
  wired: boolean;
  /** How it's wired, or null when unwired. */
  via: 'self-transition' | 'listens' | null;
}

export interface ListensAuditResult {
  /** Every button-ish emitter found (excludes fetch/persist success|failure auto-emits). */
  emitters: ListensAuditEmitter[];
  /** The unwired subset, each with a ready-to-paste `listens` line. */
  missing: Array<{ trait: string; event: string; suggestion: string }>;
}

/** Static audit — no server, no browser. Walks the schema's declared
 *  `emits`/`listens` contracts only. */
export function auditListens(orbital: OrbitalSchema): ListensAuditResult {
  const traitTransitions = buildTraitTransitions(orbital);
  const declaredListeners = buildDeclaredListeners(orbital);
  const emitters: ListensAuditEmitter[] = [];
  const missing: ListensAuditResult['missing'] = [];

  for (const orb of orbital.orbitals) {
    for (const traitRef of orb.traits) {
      if (typeof traitRef !== 'object' || !('name' in traitRef)) continue;
      const traitName = traitRef.name as string;
      const emits = ('emits' in traitRef ? traitRef.emits : undefined) ?? [];
      if (emits.length === 0) continue;

      const transitions =
        'stateMachine' in traitRef && traitRef.stateMachine && Array.isArray(traitRef.stateMachine.transitions)
          ? traitRef.stateMachine.transitions
          : [];
      const effectEmitted = collectEffectEmittedEvents(transitions);
      const selfEvents = traitTransitions.get(traitName) ?? new Set<string>();

      for (const emit of emits) {
        const event = emit.event;
        if (effectEmitted.has(event)) continue;

        const selfHandled = selfEvents.has(event);
        const sources = declaredListeners.get(event);
        const listenerHandled = sources !== undefined && (sources.has('*') || sources.has(traitName));
        const wired = selfHandled || listenerHandled;
        const via: ListensAuditEmitter['via'] = selfHandled ? 'self-transition' : listenerHandled ? 'listens' : null;

        emitters.push({ trait: traitName, event, wired, via });
        if (!wired) {
          missing.push({
            trait: traitName,
            event,
            suggestion: `listens { ${traitName}.${event} -> ${event} }`,
          });
        }
      }
    }
  }

  return { emitters, missing };
}
