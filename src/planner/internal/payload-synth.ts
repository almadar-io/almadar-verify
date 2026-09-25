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

import type { OrbitalSchema, EventPayload, PayloadField, SExpr } from '@almadar/core';
import { isEntityReference, isEntityCall, payloadTypeContainer } from '@almadar/core';
import { buildMinimalPayload, type EntityFieldDef, type PayloadFieldSpec } from '../../browser/interaction.js';

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
    // The primary entity AND every auxiliary one: an orbital whose primary
    // is its `[identity]` roster keeps its real records in `auxiliaryEntities`,
    // and a payload synthesized without their fields is a shapeless
    // placeholder the store now rejects for missing required columns.
    for (const entityRef of [orb.entity, ...(orb.auxiliaryEntities ?? [])]) {
      if (entityRef === undefined) continue;
      if (isEntityReference(entityRef) || isEntityCall(entityRef)) continue;
      const fields = entityRef.fields ?? [];
      // `EntityFieldDef` IS core's `EntityField` — pass the declared fields
      // through unchanged (min/max/intrinsic/default/relation/items/properties
      // included) instead of re-deriving a narrowed `{name,type,values}` copy.
      out[entityRef.name] = fields.filter((f): f is typeof f & { name: string } =>
        typeof f.name === 'string' && f.name.length > 0,
      );
    }
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
  const entityFields = linkedEntity !== undefined
    ? entityFieldsByName[linkedEntity] ?? []
    : [];
  // An entity-typed field names its OWN entity (`row : Channel` on a trait
  // linked to ChatMessage): expand it from that entity's declared fields,
  // not the trait's linked entity.
  const foreign: EventPayload = {};
  const rest: PayloadFieldSpec[] = [];
  for (const f of payloadSchema) {
    const own = f.entity !== undefined && f.entity !== linkedEntity ? entityFieldsByName[f.entity] : undefined;
    if (own !== undefined && own.length > 0) {
      const spec = payloadFieldSpec(f);
      foreign[f.name] = buildMinimalPayload([{ ...spec, properties: undefined }], [...own])[f.name] ?? null;
    } else {
      rest.push(payloadFieldSpec(f));
    }
  }
  return { ...buildMinimalPayload(rest, [...entityFields]), ...foreign };
}

/** The declared payload field, nested `properties` included, in the shape
 *  `buildMinimalPayload` consumes — the one owner of payload synthesis. */
export function payloadFieldSpec(f: PayloadField): PayloadFieldSpec {
  return {
    name: f.name,
    type: f.type,
    required: f.required,
    entity: f.entity,
    ...(f.properties !== undefined && f.properties.length > 0 && { properties: f.properties.map(payloadFieldSpec) }),
  };
}

/**
 * PF-15(b): fetch-data injection. A fetch-continuation guard like
 * `AUTO_OPEN when (and (not @entity.openChannel) (> (array/len ?data) 0))`
 * depends on fetch-provided ROWS, but the merged pass payload carries
 * `buildGuardPayloads`'s bare `[{ id: 'mock-test-id-0' }]` rows — the guard
 * passes, yet the transition's effects read real columns (`channel`,
 * `lastMessageAt`) off those rows and settle on undefined. When the guard
 * provably reads `(array/len @payload.<field>)`, rebuild that field as a
 * non-empty array of rows shaped from the DECLARED entity's fields (the
 * payloadSchema's `[Entity]` element type, else the trait's linked entity).
 * Deterministic; every value comes from `buildMinimalPayload`'s mock
 * conventions, so the rows read as synthesized, never as seeded data.
 */
export function injectFetchDataRows(
  guard: SExpr | undefined,
  payload: EventPayload,
  payloadSchema: ReadonlyArray<PayloadField> | undefined,
  linkedEntity: string | undefined,
  entityFieldsByName: Record<string, EntityFieldDef[]>,
): EventPayload {
  if (guard === undefined) return payload;
  const fields = guardArrayLenFields(guard);
  if (fields.length === 0) return payload;
  let out = payload;
  for (const field of fields) {
    const decl = payloadSchema?.find((f) => f.name === field);
    const elementEntity = decl !== undefined ? arrayElementEntity(decl.type) : undefined;
    const rowFields =
      (elementEntity !== undefined ? entityFieldsByName[elementEntity] : undefined) ??
      (linkedEntity !== undefined ? entityFieldsByName[linkedEntity] : undefined);
    if (rowFields === undefined || rowFields.length === 0) continue;
    const rows = buildMinimalPayload(
      [{ name: field, type: elementEntity !== undefined ? `[${elementEntity}]` : 'array' }],
      [...rowFields],
    )[field];
    if (Array.isArray(rows) && rows.length > 0) out = { ...out, [field]: rows };
  }
  return out;
}

/** Top-level `@payload.<field>` names the guard reads via `(array/len …)`. */
function guardArrayLenFields(guard: SExpr): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (node: SExpr): void => {
    if (Array.isArray(node)) {
      if (node.length === 2 && node[0] === 'array/len' && typeof node[1] === 'string') {
        const match = /^@payload\.([A-Za-z0-9_]+)$/.exec(node[1]);
        if (match !== null && !seen.has(match[1])) {
          seen.add(match[1]);
          out.push(match[1]);
        }
      }
      for (const child of node) visit(child);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const value of Object.values(node)) visit(value);
    }
  };
  visit(guard);
  return out;
}

/** The entity name inside a `[Entity]` array type; undefined for scalar/plain arrays. */
function arrayElementEntity(type: string | undefined): string | undefined {
  if (typeof type !== 'string') return undefined;
  const container = payloadTypeContainer(type);
  if (container.kind !== 'array' || container.element === '') return undefined;
  const inner = container.element;
  return inner === 'string' || inner === 'number' || inner === 'integer' || inner === 'float' || inner === 'boolean'
    ? undefined
    : inner;
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
