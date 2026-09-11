/**
 * `transient-failure-arm` — RV Verification_Runtime item 27.
 *
 * A failure-route arm (`emit.failure` target of a `persist`/`fetch`/
 * `call-service` effect) whose `from` state races forward via an
 * effect-emitted sibling transition (`creating`'s own success cascade
 * auto-advancing to `idle` before the walker's hermetic preamble can hold
 * `from` long enough to inject the failure event manually) can never be
 * observed firing by a synthetic bus dispatch of the failure event — by
 * the time the preamble settles, the machine already left `from`. The
 * only way to see the arm fire for REAL is to make the transition that
 * ENTERS `from` genuinely fail: dispatch it under a viewer the target
 * entity's own declared access policy denies.
 *
 * `deriveDenyingViewer` reuses the exact vocabulary/policy primitives
 * `deriveViewerRequirement` (the admission twin) already uses — just
 * checked in the opposite direction — plus the real evaluator
 * (`@almadar/evaluator`) so a payload-literal OR-term (`isDirect: true`,
 * unconditionally true regardless of viewer) is never mistaken for a
 * denial. A term the evaluator can't resolve (an unresolved `@entity.*`/
 * `@payload.*` binding) is never treated as proof of denial either —
 * fail-open, mirroring `guard-precondition.ts`'s doctrine: a false
 * "unreachable" is worse than skipping a probe that might have worked.
 *
 * Pure. No `Page`, no driver, no live entity data.
 *
 * @packageDocumentation
 */

import type { Effect, OrbitalSchema, SExpr, Transition } from '@almadar/core';
import { entityAccessPolicies, identityEntitiesOf, roleSatisfyingPolicy, roleVocabularyOf } from '@almadar/core/mock';
import { createMinimalContext, evaluateGuard } from '@almadar/evaluator';
import type { EntityRow } from '@almadar/core';
import type { TraitWalkConfig } from '../../engine/types.js';
import { transientClosure } from './transient-closure.js';
import type { ViewerRequirement } from './viewer-requirement.js';

export type PersistKind = 'create' | 'update' | 'delete';

export interface EnteringPersist {
  transition: Transition;
  entity: string;
  kind: PersistKind;
  data: SExpr | undefined;
}

/** Every event a trait's transitions fire via a persist/fetch/call-service
 *  effect's `emit.failure` — the union across ALL of `transitions`, not
 *  just one, since the failure-route arm and the entering effect that
 *  declares it usually live on different transitions. */
export function collectFailureEventsAcross(transitions: ReadonlyArray<Transition>): Set<string> {
  const out = new Set<string>();
  for (const t of transitions) {
    for (const effect of t.effects ?? []) collectFailureFrom(effect, out);
  }
  return out;
}

function collectFailureFrom(node: Effect | SExpr, out: Set<string>): void {
  if (!Array.isArray(node)) return;
  const nodes = node as readonly SExpr[];
  if (nodes[0] === 'persist' || nodes[0] === 'fetch' || nodes[0] === 'call-service') {
    for (const arg of nodes) {
      if (arg === null || typeof arg !== 'object' || Array.isArray(arg)) continue;
      const emit = (arg as Readonly<Record<string, SExpr>>)['emit'];
      if (emit === null || typeof emit !== 'object' || Array.isArray(emit)) continue;
      const failure = (emit as Readonly<Record<string, SExpr>>)['failure'];
      if (typeof failure === 'string' && failure.length > 0) out.add(failure);
    }
  }
  for (const child of nodes) collectFailureFrom(child, out);
}

/** Whether `event` is a failure-route arm whose `from` cannot be held for
 *  a manual dispatch — it races forward via an effect-emitted sibling. */
export function isTransientFailureArm(
  from: string,
  event: string,
  transitions: ReadonlyArray<Transition>,
  walkConfig: TraitWalkConfig,
): boolean {
  if (!collectFailureEventsAcross(transitions).has(event)) return false;
  return transientClosure(from, walkConfig).length > 1;
}

/** The transition (anywhere in the trait) whose own persist/fetch/
 *  call-service effect declares `emit.failure === failureEvent` — the
 *  transition that, dispatched for real, can make this failure fire. */
export function findEnteringPersist(
  transitions: ReadonlyArray<Transition>,
  failureEvent: string,
): EnteringPersist | null {
  for (const transition of transitions) {
    for (const effect of transition.effects ?? []) {
      const found = matchPersistEmittingFailure(effect, failureEvent);
      if (found !== null) return { transition, ...found };
    }
  }
  return null;
}

function matchPersistEmittingFailure(
  node: Effect | SExpr,
  failureEvent: string,
): { entity: string; kind: PersistKind; data: SExpr | undefined } | null {
  if (!Array.isArray(node)) return null;
  const nodes = node as readonly SExpr[];
  if (nodes[0] === 'persist') {
    const kind = nodes[1];
    if ((kind === 'create' || kind === 'update' || kind === 'delete') && typeof nodes[2] === 'string') {
      for (let i = 3; i < nodes.length; i++) {
        const arg = nodes[i];
        if (arg === null || typeof arg !== 'object' || Array.isArray(arg)) continue;
        const emit = (arg as Readonly<Record<string, SExpr>>)['emit'];
        if (emit === null || typeof emit !== 'object' || Array.isArray(emit)) continue;
        const failure = (emit as Readonly<Record<string, SExpr>>)['failure'];
        if (failure === failureEvent) {
          return { entity: nodes[2], kind, data: nodes[3] };
        }
      }
    }
  }
  for (const child of nodes) {
    const found = matchPersistEmittingFailure(child, failureEvent);
    if (found !== null) return found;
  }
  return null;
}

/**
 * A role from the identity entity's own declared vocabulary that entity
 * `entity`'s `kind` access policy provably rejects for THIS persist's
 * literal payload fields. `undefined` when no declared role is provably
 * denied — no policy at all, every declared role satisfies it (an OR
 * spanning the whole roster), or a non-role clause makes the policy true
 * independent of the viewer (a payload literal like `isDirect: true`).
 */
export function deriveDenyingViewer(
  schema: OrbitalSchema,
  entity: string,
  kind: PersistKind,
  persistData: SExpr | undefined,
): ViewerRequirement | undefined {
  const policy = entityAccessPolicies(schema, entity)?.[kind];
  if (policy === undefined || policy === null) return undefined;

  const identity = identityEntitiesOf(schema.orbitals ?? [])[0];
  if (identity === undefined) return undefined;
  const roleField = identity.fields.find((f) => f.name === 'role');
  if (roleField === undefined) return undefined;
  const vocab = roleVocabularyOf(identity) ?? [];
  if (vocab.length === 0) return undefined;

  const entityRow = literalRowOf(persistData);

  for (const candidate of vocab) {
    const narrowedIdentity = {
      ...identity,
      fields: identity.fields.map((f) => (f === roleField ? { ...f, values: [candidate] } : f)),
    };
    // A candidate that satisfies via a role-literal clause can't deny.
    if (roleSatisfyingPolicy(policy, narrowedIdentity) !== undefined) continue;

    const ctx = createMinimalContext(entityRow, {}, 'transient-failure-probe');
    ctx.user = { id: 'transient-failure-probe-viewer', role: candidate };
    let denies: boolean;
    try {
      denies = evaluateGuard(policy, ctx) === false;
    } catch {
      // Can't prove it either way — never force a false denial.
      continue;
    }
    if (denies) return { role: { field: 'role', value: candidate } };
  }
  return undefined;
}

/**
 * Literal (non-binding) fields of a persist's data object. A binding
 * (`@entity.x`, `@payload.x`) or nested S-expr call resolves to nothing
 * here — the caller can't know its runtime value statically, so a policy
 * term depending on one stays correctly unproven rather than guessed.
 */
function literalRowOf(data: SExpr | undefined): EntityRow {
  const out: EntityRow = {};
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) return out;
  for (const [key, value] of Object.entries(data as Readonly<Record<string, SExpr>>)) {
    if (Array.isArray(value)) continue;
    if (value !== null && typeof value === 'object') continue;
    if (typeof value === 'string' && value.startsWith('@')) continue;
    out[key] = value;
  }
  return out;
}
