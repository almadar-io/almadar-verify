/**
 * `viewer-requirement` — C1-V9 item A: the JS twin of `orbital-verify`'s
 * per-step persona derivation (`orbital-rust/crates/orbital-verify/src/
 * lib.rs`'s `verify_with_harness` + `planner::persist_targets` +
 * `orbital_core::runtime::entity_access::role_satisfying_policy`).
 *
 * A `persist create|update|delete` step is denied under whichever default
 * viewer the walk happens to be bound as unless that viewer's identity
 * satisfies the entity's OWN declared access policy for that action. This
 * module answers, statically from the schema, WHAT a satisfying viewer
 * needs to carry — a role literal, an owner id, or both (an `and` of the
 * two). Resolving that into a CONCRETE persona value (reading a real
 * seeded row's owner column, or the driver's default persona's own id)
 * needs live data the planner never sees, so that half is `tick()`'s job
 * (`driver/tick.ts`).
 *
 * Pure. No `Page`, no driver, no live entity data.
 *
 * @packageDocumentation
 */

import type { OrbitalSchema } from '@almadar/core';
import {
  entityAccessPolicies,
  identityEntitiesOf,
  identityEntityName,
  ownerColumnsFromPolicy,
  roleSatisfyingPolicy,
} from '@almadar/core/mock';

/**
 * What a viewer must carry to pass one entity's declared access policy for
 * one action. `role` and `owner` are independent findings — BOTH may be
 * set (an `and`-combined policy needs both; an `or`-combined policy is
 * over-satisfied by carrying both, which is harmless) per
 * `roleSatisfyingPolicy`'s own "candidate, never a proof" contract.
 * Neither set (an empty `{}`) is a genuine finding on its own: the policy
 * IS declared, but no role-vocabulary literal and no owner-column
 * comparison could be found in it — `tick()` reports this as
 * `no-satisfying-persona` rather than silently walking under the default
 * viewer (which the policy would then deny for real, indistinguishable
 * from a genuine access bug).
 */
export interface ViewerRequirement {
  /** A `@user.<field>` literal (declared identity-entity vocabulary) the
   *  policy compares against — `roleSatisfyingPolicy`'s field defaults to
   *  `'role'`, the only field name the identity roster declares today. */
  role?: { field: string; value: string };
  owner?: {
    /** Where to read a REAL identity id from at dispatch time. */
    sourceEntity: string;
    sourceField: string;
    /**
     * `create`: no target row exists yet to read an owner column from —
     * `sourceEntity`/`sourceField` name the `[identity]` entity's own `id`
     * (or the self-identity entity's own `id`, when `sourceEntity` IS the
     * identity entity), so `tick()` reads it off the driver's DEFAULT
     * persona instead of a seeded row.
     */
    useDefaultId?: boolean;
    /**
     * `create` only: the dispatched payload's OWN field that must be
     * stamped with the resolved id — the new row must self-declare its
     * ownership, or its own `@create` policy denies the write it is
     * about to make.
     */
    payloadOwnerField?: string;
  };
}

/**
 * Derive the viewer requirement for one entity's `create|update|delete`
 * action from the schema's own declared access policy — `undefined` when
 * the action declares no policy at all (no restriction, no requirement).
 * A DECLARED policy from which neither a role nor an owner column can be
 * read still returns an object (`{}`), distinct from `undefined`, so the
 * caller can tell "no restriction" from "restricted, but this walker
 * can't currently derive who satisfies it."
 */
export function deriveViewerRequirement(
  schema: OrbitalSchema,
  entityName: string,
  kind: 'create' | 'update' | 'delete',
): ViewerRequirement | undefined {
  const policies = entityAccessPolicies(schema, entityName);
  const policy = kind === 'create' ? policies?.create : kind === 'update' ? policies?.update : policies?.delete;
  if (policy === undefined) return undefined;

  const identity = identityEntitiesOf(schema.orbitals ?? [])[0];
  const roleValue = identity !== undefined ? roleSatisfyingPolicy(policy, identity) : undefined;
  const ownerCols = ownerColumnsFromPolicy(policy);

  const requirement: ViewerRequirement = {};
  if (roleValue !== undefined) {
    requirement.role = { field: 'role', value: roleValue };
  }
  if (ownerCols.length > 0) {
    const ownerField = ownerCols[0];
    requirement.owner = kind === 'create'
      ? {
        sourceEntity: identityEntityName(schema) ?? entityName,
        sourceField: 'id',
        useDefaultId: true,
        payloadOwnerField: ownerField,
      }
      : { sourceEntity: entityName, sourceField: ownerField };
  }
  return requirement;
}
