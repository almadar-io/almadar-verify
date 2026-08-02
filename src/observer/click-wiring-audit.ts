/**
 * `auditListens` — static audit of an orbital's `emits` → `listens` wiring.
 *
 * A trait's `emits {}` contract declares events it broadcasts for other
 * traits to react to. Each declared emit is "wired" when the emitting trait
 * itself reacts to it (a self-transition on the same event key), when an
 * embedding host up the embed chain does (embedded chrome emits under its
 * embedder's scope), or when some trait's `listens {}` block subscribes to it —
 * **and that reaction actually carries effects**. An emit with none of the three
 * is a dead broadcast; the fix is always a `listens` line on the consuming
 * trait, never a heuristic guess.
 *
 * The third verdict, `wired: 'bodiless'`, is the one this audit used to miss.
 * A transition on the event exists but every arm on it is effect-free, so the
 * emit is routed to a handler that paints nothing and changes nothing — the
 * button is as dead as an unrouted one, while the old boolean called it wired.
 * That is `V-AUDIT-LISTENS-COUNTS-A-BODILESS-SELF-TRANSITION-AS-WIRED`, found in
 * W6: `std-fitness-studio` renames `NOTIFY_CLICK` onto `std-app-layout.lolo:52`'s
 * `NOTIFY_CLICK -> composing`, which has no body. Its fix is the opposite of
 * `missing`'s, so it gets its own bucket rather than being folded in.
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

import type { OrbitalSchema, TraitEventListener, Transition } from '@almadar/core';
import { collectEmbeddedTraitReferrers } from '@almadar/core';
import { collectEffectEmittedEvents } from '../planner/internal/effect-emits.js';

/** For each trait, the set of events its own state machine transitions on. */
export function buildTraitTransitions(orbital: OrbitalSchema): Map<string, Set<string>> {
  return collectTraitEvents(orbital, false);
}

/**
 * For each trait, the subset of `buildTraitTransitions` whose arms actually do
 * something — at least one transition on that event carries ≥1 effect.
 *
 * `get_state_render_effects` (`orbital-core/src/runtime/kernel.rs:530`) re-applies
 * a state's render ONLY in the no-transition branch, so entering a state BY
 * transition paints exactly what the arm renders. An arm with no effects paints
 * nothing, changes nothing, and the affordance routed to it is dead — even
 * though a transition on that event demonstrably exists.
 *
 * `lintWiring`'s `dead-bodiless-action` deliberately skips `from === to` arms
 * ("a self-transition leaves the current paint standing"), which is right about
 * the paint and wrong about the button. That blind spot is exactly this map's
 * job: `V-AUDIT-LISTENS-COUNTS-A-BODILESS-SELF-TRANSITION-AS-WIRED`.
 */
export function buildTraitEffectfulTransitions(orbital: OrbitalSchema): Map<string, Set<string>> {
  return collectTraitEvents(orbital, true);
}

function collectTraitEvents(orbital: OrbitalSchema, effectfulOnly: boolean): Map<string, Set<string>> {
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
          if (!trans || typeof trans !== 'object' || !('event' in trans)) continue;
          const arm = trans as Transition;
          if (effectfulOnly && (arm.effects ?? []).length === 0) continue;
          events.add(arm.event);
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

/**
 * Walk the embed chain upward from `trait`, in order, stopping on a cycle.
 *
 * Embedded chrome (a named `<trait.X />` embed or a compiler-lowered
 * `Inline*Render` child) emits under its EMBEDDER's scope: the runtime's embed
 * routing delivers the event to the host, never to a subscription on the
 * child's own bus key. So a host's self-transition IS the child's wiring —
 * `assertClickNoListener` has always credited it, and this audit not doing so
 * was `T-AUDIT-LISTENS-INLINE-CHILD-FALSE-POSITIVE`.
 */
function embedHostChain(trait: string, hosts: ReadonlyMap<string, string>): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([trait]);
  for (let host = hosts.get(trait); host !== undefined && !seen.has(host); host = hosts.get(host)) {
    seen.add(host);
    chain.push(host);
  }
  return chain;
}

/**
 * One trait's declared `emits` event, and whether anything reacts to it.
 *
 * Three verdicts, not two — `'bodiless'` is the middle one: a transition on the
 * event exists, so the emit is routed, but every arm on that route carries zero
 * effects, so pressing the affordance produces nothing. Reporting that as
 * `wired: true` is what let four dead controls through the gate in W6.
 */
export interface ListensAuditEmitter {
  trait: string;
  event: string;
  wired: boolean | 'bodiless';
  /** How it's wired (or would be, when `'bodiless'`); null only when nothing routes it. */
  via: 'self-transition' | 'host-transition' | 'listens' | null;
  /** The embedding host that handles it, when `via` is `'host-transition'`. */
  host?: string;
}

export interface ListensAuditResult {
  /** Every button-ish emitter found (excludes fetch/persist success|failure auto-emits). */
  emitters: ListensAuditEmitter[];
  /** The unrouted subset, each with a ready-to-paste `listens` line. */
  missing: Array<{ trait: string; event: string; suggestion: string }>;
  /**
   * The routed-but-effect-less subset. Distinct from `missing` because the fix
   * is the opposite one: give the existing arm a body. Adding a `listens` line
   * here would route the event a second time and still paint nothing.
   */
  bodiless: Array<{ trait: string; event: string; handler: string; suggestion: string }>;
}

/** Static audit — no server, no browser. Walks the schema's declared
 *  `emits`/`listens` contracts only. */
export function auditListens(orbital: OrbitalSchema): ListensAuditResult {
  const traitTransitions = buildTraitTransitions(orbital);
  const effectfulTransitions = buildTraitEffectfulTransitions(orbital);
  const declaredListeners = buildDeclaredListeners(orbital);
  const embedHosts = collectEmbeddedTraitReferrers(orbital);
  const emitters: ListensAuditEmitter[] = [];
  const missing: ListensAuditResult['missing'] = [];
  const bodiless: ListensAuditResult['bodiless'] = [];

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
        const selfEffectful = effectfulTransitions.get(traitName)?.has(event) === true;
        const sources = declaredListeners.get(event);
        const chain = embedHostChain(traitName, embedHosts);
        // An effect-carrying host outranks a bodiless one: a real route anywhere
        // up the chain IS the wiring, and reporting the nearest dead host instead
        // would invent a defect.
        const effectfulHost = chain.find(
          (host) => effectfulTransitions.get(host)?.has(event) === true || sources?.has(host) === true,
        );
        const hostHandler =
          effectfulHost ??
          chain.find((host) => traitTransitions.get(host)?.has(event) === true || sources?.has(host) === true);
        // A `listens` subscriber is an explicit opt-in by another trait; whether
        // THAT trait's own arm has a body is its own audit row, not this one's.
        const listenerHandled = sources !== undefined && (sources.has('*') || sources.has(traitName));

        const routed = selfHandled || hostHandler !== undefined || listenerHandled;
        const effectful = selfEffectful || effectfulHost !== undefined || listenerHandled;
        const wired: ListensAuditEmitter['wired'] = effectful ? true : routed ? 'bodiless' : false;
        const via: ListensAuditEmitter['via'] = selfHandled
          ? 'self-transition'
          : hostHandler !== undefined
            ? 'host-transition'
            : listenerHandled
              ? 'listens'
              : null;

        emitters.push({ trait: traitName, event, wired, via, ...(hostHandler ? { host: hostHandler } : {}) });
        if (wired === false) {
          missing.push({
            trait: traitName,
            event,
            suggestion: `listens { ${traitName}.${event} -> ${event} }`,
          });
        } else if (wired === 'bodiless') {
          const handler = selfHandled ? traitName : (hostHandler ?? traitName);
          bodiless.push({
            trait: traitName,
            event,
            handler,
            suggestion:
              `${handler} transitions on '${event}' but every arm on it carries zero effects, so the affordance ` +
              `paints nothing and changes nothing. Give the arm the body its target state should show — ` +
              `a render (and its fetch, if any). Adding a \`listens\` line does not fix this`,
          });
        }
      }
    }
  }

  return { emitters, missing, bodiless };
}
