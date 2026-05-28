/**
 * Payload-synthesis helpers shared across planners.
 *
 * Centralizes:
 *   - `collectEntityFields` (lifted from `plan-user-crud-flow.ts`):
 *     walks the orbital and produces a `Record<entityName, EntityFieldDef[]>`
 *     so any planner can synthesize entity-shaped payloads.
 *   - `synthesizeSuccessPayload`: turns a `PayloadField[]` into a valid
 *     event payload via `buildMinimalPayload`. Used by `planWalk` for
 *     the per-transition `success` variant; the rejected `malformed`
 *     variant just sends `{}`.
 *
 * Pure. No browser, no I/O.
 *
 * @packageDocumentation
 */

import type { OrbitalSchema, EventPayload, PayloadField } from '@almadar/core';
import { isEntityReference, isEntityCall } from '@almadar/core';
import { buildMinimalPayload, type EntityFieldDef } from '../../browser/interaction.js';

/**
 * Build a name → fields map for every inline-defined entity in the
 * orbital. Skips entity references (`{ extends: ... }`) and entity
 * calls (cross-orbital reuse) — those don't carry a literal field
 * declaration here. Used by payload synthesis to expand entity-typed
 * fields (e.g. `data: ListItem`) into real row shapes.
 */
export function collectEntityFields(orbital: OrbitalSchema): Record<string, EntityFieldDef[]> {
  const out: Record<string, EntityFieldDef[]> = {};
  for (const orb of orbital.orbitals) {
    const entityRef = orb.entity;
    if (entityRef === undefined) continue;
    if (isEntityReference(entityRef) || isEntityCall(entityRef)) continue;
    const fields = entityRef.fields ?? [];
    out[entityRef.name] = fields
      .filter((f): f is typeof f & { name: string } =>
        typeof f.name === 'string' && f.name.length > 0,
      )
      .map((f) => ({
        name: f.name,
        type: f.type,
      }));
  }
  return out;
}

/**
 * Synthesize a valid `success`-case payload from an event's
 * `payloadSchema`. Returns `{}` when the schema is empty or undefined.
 *
 * Delegates to `buildMinimalPayload` which handles primitives, arrays,
 * `object`/`any` (expanded to entity row shape), and entity-name refs
 * (expanded the same way). The resulting payload is what `planWalk`
 * dispatches for the `success` variant — the validator sees every
 * required field populated, the state machine fires, and downstream
 * observers see the real success-path effects.
 */
export function synthesizeSuccessPayload(
  payloadSchema: ReadonlyArray<PayloadField> | undefined,
  linkedEntity: string | undefined,
  entityFieldsByName: Record<string, EntityFieldDef[]>,
): EventPayload {
  if (payloadSchema === undefined || payloadSchema.length === 0) return {};
  const fields = payloadSchema.map((f) => ({
    name: f.name,
    type: f.type,
    required: f.required,
  }));
  const entityFields = linkedEntity !== undefined
    ? entityFieldsByName[linkedEntity] ?? []
    : [];
  return buildMinimalPayload(fields, [...entityFields]);
}

/**
 * Whether the schema declares at least one field with `required: true`.
 * Used by `planWalk` to decide whether to emit the `malformed` variant
 * — events with no required fields would have an empty `{}` payload as
 * BOTH malformed and success, so emitting both would just duplicate the
 * coverage entry without exercising any validator branch.
 */
export function hasRequiredPayloadFields(
  payloadSchema: ReadonlyArray<PayloadField> | undefined,
): boolean {
  if (payloadSchema === undefined) return false;
  return payloadSchema.some((f) => f.required === true);
}
