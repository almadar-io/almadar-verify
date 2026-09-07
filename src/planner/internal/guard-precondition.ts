/**
 * `guard-precondition` — C1-V15 item A: a guarded transition whose guard
 * reads a NON-id `@entity.<field>` (`persist-binding.ts` already owns the
 * `@entity.id` row-identity shape) that this trait never sets on its own —
 * the precondition is established by a SIBLING trait linked to the SAME
 * entity (std-helpdesk's `TicketReplyPersistor.DO_CREATE -> idle when
 * @entity.activeTicketId`, set only by `TicketReplyBrowse.SELECT_TICKET`).
 *
 * `runVerification`'s reconcile preamble (`planReplayTo`) only ever walks
 * ONE trait's own topology — a guard whose precondition lives on a
 * different trait's state machine has no path to it at all, so the
 * hermetic per-step reset silently strands the field at its default and
 * the guard fails cold every time. This generalizes C1-V14's
 * `establishesRow`/`beforeReplay` machinery (still `@entity.id`-scoped in
 * `persist-binding.ts`) to an arbitrary field AND an arbitrary
 * establishing trait, reusing the SAME `tick()`/`runVerification` dispatch
 * path via the new `establishesRow.traitName` field.
 *
 * Pure. No `Page`, no DOM.
 *
 * @packageDocumentation
 */

import { collectBindings } from '@almadar/core';
import type { Effect, FieldValue, OrbitalSchema, SExpr, Trait, Transition } from '@almadar/core';
import { eachInlineTrait, findInitialState } from './orbital-walk.js';
import { findPersistKind } from './persist-binding.js';
import { synthesizeSuccessPayload } from './payload-synth.js';
import type { EntityFieldDef } from '../../browser/interaction.js';
import { deriveViewerRequirement, type ViewerRequirement } from './viewer-requirement.js';

/** The establishing-preamble shape `planGuardPreconditionPreamble` builds —
 *  structurally identical to `ExtendedWalkStep['establishesRow']` (which
 *  this file must not import, to avoid a `planner/types.ts` ⇄ `internal/`
 *  cycle: `types.ts` already imports `ViewerRequirement` from this dir). */
export interface GuardEstablishPreamble {
  event: string;
  payload: Record<string, FieldValue>;
  bindRowFrom?: { entityName: string; payloadField: string };
  viewerRequirement?: ViewerRequirement;
  beforeReplay?: boolean;
  /** The trait to DISPATCH this preamble against — the setter trait, which
   *  may differ from the guarded transition's own trait (the sibling
   *  shape). Undefined means "the same trait as the step" (back-compat
   *  with the pre-existing `@entity.id` preambles, which never set this). */
  traitName?: string;
}

/**
 * `@entity.<field>` bindings a guard reads, excluding `id` — the pre-
 * existing row-identity machinery in `persist-binding.ts` (`findRow
 * CreatingSelfLoop` / `findRowSelectingTransitionFromState`) already owns
 * that one. A guard may read several distinct entity fields (`and`ed
 * together); returned in the order `collectBindings` discovers them, de-duped.
 */
export function entityFieldGuardBindings(guard: SExpr): string[] {
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const binding of collectBindings(guard)) {
    const match = /^@entity\.([A-Za-z0-9_]+)$/.exec(binding);
    if (match === null) continue;
    const field = match[1];
    if (field === 'id' || seen.has(field)) continue;
    seen.add(field);
    fields.push(field);
  }
  return fields;
}

/** What {@link findEntityFieldSet} found scanning one transition's effects
 *  for `(set "@entity.<field>" value)`. */
export interface EntityFieldSetInfo {
  /** `true` iff SOME effect sets `@entity.<field>`, regardless of source. */
  sets: boolean;
  /** The top-level `@payload.<x>` path it's bound from, when the value is a
   *  bare top-level payload reference — `null` for a literal/computed value
   *  (nothing to bind from a seeded row) OR a nested path (`@payload.row.x`
   *  has no single payload slot to inject a real value into — same "no
   *  single slot" rule `persist-binding.ts`'s id-binding finders apply). */
  payloadPath: string | null;
}

const PAYLOAD_PREFIX = '@payload.';

export function findEntityFieldSet(effects: ReadonlyArray<Effect>, field: string): EntityFieldSetInfo {
  const targetPath = `@entity.${field}`;
  for (const effect of effects) {
    if (!Array.isArray(effect)) continue;
    const value = findEntityFieldSetInExpr(effect as SExpr, targetPath);
    if (value === undefined) continue;
    if (typeof value === 'string' && value.startsWith(PAYLOAD_PREFIX)) {
      const path = value.slice(PAYLOAD_PREFIX.length);
      return { sets: true, payloadPath: path.includes('.') ? null : path };
    }
    return { sets: true, payloadPath: null };
  }
  return { sets: false, payloadPath: null };
}

function findEntityFieldSetInExpr(node: SExpr, targetPath: string): SExpr | undefined {
  if (Array.isArray(node)) {
    if (node.length === 3 && node[0] === 'set' && node[1] === targetPath) {
      return node[2];
    }
    for (const child of node) {
      const found = findEntityFieldSetInExpr(child, targetPath);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node)) {
      const found = findEntityFieldSetInExpr(value, targetPath);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** A trait + transition that sets `@entity.<field>` and is legitimately
 *  dispatchable as a standalone preamble. */
export interface FieldSettingCandidate {
  trait: Trait;
  transition: Transition;
}

/**
 * Find a transition — on `guardedTraitName` itself OR any SIBLING trait
 * sharing `linkedEntity` — that sets `@entity.<field>` and can legitimately
 * be dispatched as a one-off preamble BEFORE the guarded step:
 *
 *   - Same trait as the guard: must be a self-loop AT `atState` (mirrors
 *     `persist-binding.ts`'s `findRowCreatingSelfLoop` — landing anywhere
 *     else would leave the trait's OWN reconcile-to-`atState` walk invalid,
 *     since this preamble fires before those hops).
 *   - A sibling trait: dispatchable from ITS OWN initial state (or `'*'`)
 *     — no landing-state constraint, because the sibling's post-dispatch
 *     state has no bearing on the guarded trait's own reconcile walk; they
 *     are different state machines that merely share the entity.
 *
 * `INIT` is excluded on both arms — it fires automatically on mount, not
 * via a re-dispatchable `sendEvent`.
 */
export function findFieldSettingCandidate(
  orbital: OrbitalSchema,
  linkedEntity: string,
  field: string,
  guardedTraitName: string,
  atState: string,
): FieldSettingCandidate | null {
  for (const { trait } of eachInlineTrait(orbital)) {
    if (trait.linkedEntity !== linkedEntity) continue;
    if (trait.stateMachine === undefined) continue;
    const isSameTrait = trait.name === guardedTraitName;
    const requiredFrom = isSameTrait ? atState : findInitialState(trait.stateMachine);
    if (requiredFrom === null) continue;
    for (const transition of trait.stateMachine.transitions) {
      if (transition.event === 'INIT') continue;
      if (transition.from !== requiredFrom && transition.from !== '*') continue;
      if (isSameTrait && transition.to !== atState) continue;
      if (!findEntityFieldSet(transition.effects ?? [], field).sets) continue;
      return { trait, transition };
    }
  }
  return null;
}

/**
 * Determine which entity's row a setter transition's top-level
 * `@payload.<payloadPath>` field identifies, so `tick()` can bind a REAL
 * seeded row into it (`bindRowFrom`) instead of a synthesized fake id.
 * Deterministic, schema-driven — never a name guess:
 *
 *   1. The setter EVENT's own declared `payloadSchema` field carries the
 *      lowering-stamped `entity` marker (`PayloadField.entity`) — the same
 *      marker `persist-binding.ts`'s `isWholeRowField` reads.
 *   2. Else, the event is the TARGET of a `listens` fan-out on the setter
 *      trait (`TraitEventListener.triggers === eventKey`, `source.kind ===
 *      'trait'`) whose `payloadMapping[payloadPath]` is a bare top-level
 *      `@payload.<x>` reference into the SOURCE event's own payload — the
 *      source trait's own `linkedEntity` is what that scalar identifies
 *      (std-helpdesk: `SELECT_TICKET.id` <- `payloadMapping.id` = `@payload.id`
 *      <- `TicketThreadRail.VIEW`, `TicketThreadRail.linkedEntity ===
 *      'ReplyTicket'`). A NESTED source reference (`@payload.row.id`) is
 *      excluded — that names a field of the row, not the row's own identity
 *      pointer, and (per {@link findEntityFieldSet}'s doc) never reaches
 *      here as `payloadPath` in the first place.
 *
 * Returns `null` when neither resolves — the caller then dispatches the
 * preamble with its synthesized (non-real) payload rather than guessing.
 */
export function resolveReferencedEntityForPayloadField(
  orbital: OrbitalSchema,
  setterTrait: Trait,
  eventKey: string,
  payloadPath: string,
): string | null {
  const event = setterTrait.stateMachine?.events.find((e) => e.key === eventKey);
  const declaredField = event?.payloadSchema?.find((f) => f.name === payloadPath);
  if (declaredField?.entity !== undefined) return declaredField.entity;

  const listenEntry = (setterTrait.listens ?? []).find(
    (l) => l.triggers === eventKey && l.source !== undefined && l.source.kind === 'trait',
  );
  if (listenEntry === undefined || listenEntry.source === undefined || listenEntry.source.kind !== 'trait') return null;
  const mapped = listenEntry.payloadMapping?.[payloadPath];
  if (typeof mapped !== 'string' || !/^@payload\.[A-Za-z0-9_]+$/.test(mapped)) return null;

  const sourceTraitName = listenEntry.source.trait;
  for (const { trait: candidate } of eachInlineTrait(orbital)) {
    if (candidate.name === sourceTraitName) return candidate.linkedEntity ?? null;
  }
  return null;
}

/**
 * Top-level orchestrator: given a guarded transition, find and build the
 * establishing preamble (or the fail-closed reason there isn't one). Only
 * the FIRST unestablished `@entity.<field>` binding is handled — a
 * transition gated on multiple SEPARATELY-established sibling fields isn't
 * in the corpus today and `establishesRow` carries exactly one preamble;
 * extending to a chain is deferred until a real case needs it.
 */
export function planGuardPreconditionPreamble(
  orbital: OrbitalSchema,
  trait: Trait,
  transition: Transition,
  atState: string,
  entityFieldsByName: Record<string, EntityFieldDef[]>,
): { establishesRow?: GuardEstablishPreamble; guardPreconditionUnreachable?: string } {
  if (transition.guard === undefined) return {};
  if (trait.linkedEntity === undefined) return {};
  if (atState === '*') return {};

  const fields = entityFieldGuardBindings(transition.guard);
  if (fields.length === 0) return {};

  const field = fields[0];
  const candidate = findFieldSettingCandidate(orbital, trait.linkedEntity, field, trait.name, atState);
  if (candidate === null) {
    return {
      guardPreconditionUnreachable:
        `guard-precondition-unreachable: trait '${trait.name}' transition '${transition.from}+${transition.event}` +
        `->${transition.to}' reads '@entity.${field}' in its guard, but no transition on this trait or any ` +
        `sibling trait linked to '${trait.linkedEntity}' ever sets it`,
    };
  }

  const info = findEntityFieldSet(candidate.transition.effects ?? [], field);
  const setterEvent = candidate.trait.stateMachine?.events.find((e) => e.key === candidate.transition.event);
  const payload = synthesizeSuccessPayload(
    setterEvent?.payloadSchema,
    candidate.trait.linkedEntity,
    entityFieldsByName,
  ) as Record<string, FieldValue>;

  const setterPersist = findPersistKind(candidate.transition.effects ?? []);
  const viewerRequirement = setterPersist !== null
    ? deriveViewerRequirement(orbital, setterPersist.entity, setterPersist.kind)
    : undefined;

  let bindRowFrom: { entityName: string; payloadField: string } | undefined;
  if (info.payloadPath !== null) {
    const referencedEntity = resolveReferencedEntityForPayloadField(
      orbital,
      candidate.trait,
      candidate.transition.event,
      info.payloadPath,
    );
    if (referencedEntity !== null) {
      bindRowFrom = { entityName: referencedEntity, payloadField: info.payloadPath };
    }
  }

  return {
    establishesRow: {
      event: candidate.transition.event,
      payload,
      traitName: candidate.trait.name,
      beforeReplay: true,
      ...(bindRowFrom !== undefined && { bindRowFrom }),
      ...(viewerRequirement !== undefined && { viewerRequirement }),
    },
  };
}
