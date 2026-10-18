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

import type { Effect, EntityRow, OrbitalSchema, EventPayload, FieldProjection, PayloadField, SExpr } from '@almadar/core';
import { isEntityReference, isEntityCall, payloadTypeContainer } from '@almadar/core';
import { guardPasses } from './kernel-eval.js';
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

/**
 * The guard's synthesized payload steers a field, but the guard cannot see the field's declared
 * type: a bare `@payload.x` existence guard mocks a row-shaped object even where `x` is declared a
 * primitive (`hasFile : boolean`), and the runtime rightly refuses that value. A row-shaped mock on
 * a declared boolean/string/number field is replaced by the typed value that satisfies the same
 * truthiness: `true` for a boolean, the typed success value for a string or number. A null on such a
 * field is the guard's "falsy" mock, which the validator refuses: it becomes `false`, `''` or `0`.
 */
export function conformGuardPayload(
  guardPayload: EventPayload,
  payloadSchema: ReadonlyArray<PayloadField> | undefined,
  successPayload: EventPayload,
): EventPayload {
  if (payloadSchema === undefined) return guardPayload;
  const out: EventPayload = { ...guardPayload };
  for (const field of payloadSchema) {
    const value = out[field.name];
    if (value === null) {
      if (field.type === 'boolean') out[field.name] = false;
      else if (field.type === 'string') out[field.name] = '';
      else if (field.type === 'number') out[field.name] = 0;
      continue;
    }
    if (typeof value !== 'object' || Array.isArray(value)) continue;
    if (field.type === 'boolean') out[field.name] = true;
    else if (field.type === 'string' || field.type === 'number') out[field.name] = successPayload[field.name] ?? null;
  }
  return out;
}

type DeclaredTypes = Readonly<Record<string, ReadonlyArray<PayloadField>>>;

/** The program's type declarations by name, across every orbital. */
export function declaredTypesOf(schema: OrbitalSchema | undefined): DeclaredTypes {
  return Object.assign({}, ...(schema?.orbitals ?? []).map((o) => ('types' in o ? o.types : undefined) ?? {}));
}

interface JsonParseSites {
  /** Payload fields read through `(json/parse @payload.<f> <Type>)`, by declared type name. */
  fields: Record<string, string>;
  /** Members of a bound value read through `(json/parse @<name>.<member> <Type>)` (a parsed instance's own JSON text member). */
  members: Record<string, string>;
}

function jsonParseSites(transition: { guard?: SExpr; effects?: ReadonlyArray<Effect> }, types: DeclaredTypes): JsonParseSites {
  const out: JsonParseSites = { fields: {}, members: {} };
  const visit = (node: Effect | SExpr): void => {
    if (!Array.isArray(node)) return;
    const nodes = node as readonly SExpr[];
    if (nodes[0] === 'json/parse' && typeof nodes[1] === 'string' && typeof nodes[2] === 'string' && types[nodes[2]] !== undefined) {
      const path = /^@([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(nodes[1]);
      if (path !== null && path[1] === 'payload') out.fields[path[2]] = nodes[2];
      else if (path !== null) out.members[path[2]] = nodes[2];
    }
    for (const child of nodes) visit(child);
  };
  if (transition.guard !== undefined) visit(transition.guard);
  for (const effect of transition.effects ?? []) visit(effect);
  return out;
}

function jsonParseFieldTypes(transition: { guard?: SExpr; effects?: ReadonlyArray<Effect> }, types: DeclaredTypes): Record<string, string> {
  return jsonParseSites(transition, types).fields;
}

/**
 * Payload fields the arm reads through `(json/parse @payload.<f> <Type>)`, filled with the JSON text of a minimal
 * instance of the program's own declared `<Type>`: random text would parse to the type's defaults and hide what
 * the arm does with a real value.
 */
export function synthesizeJsonParsePayload(
  transition: { guard?: SExpr; effects?: ReadonlyArray<Effect> },
  types: DeclaredTypes,
  entityFields: ReadonlyArray<EntityFieldDef> = [],
): EventPayload {
  const out: EventPayload = {};
  const sites = jsonParseSites(transition, types);
  const minimal = (typeName: string): EventPayload => buildMinimalPayload((types[typeName] ?? []).map(payloadFieldSpec), [...entityFields]);
  for (const [field, typeName] of Object.entries(sites.fields)) {
    const instance = minimal(typeName);
    for (const [member, memberType] of Object.entries(sites.members)) {
      if (typeof instance[member] === 'string') instance[member] = JSON.stringify(minimal(memberType));
    }
    out[field] = JSON.stringify(instance);
  }
  return out;
}

type JsonLeaf = string | number | boolean | JsonLeaf[] | { [key: string]: JsonLeaf };

function literalsOf(node: SExpr, out: Set<string | number>): void {
  if (typeof node === 'string' && !node.startsWith('@') && !node.startsWith('?')) out.add(node);
  else if (typeof node === 'number') out.add(node);
  else if (Array.isArray(node)) for (const child of node as readonly SExpr[]) literalsOf(child, out);
}

/**
 * Steer the JSON instances `synthesizeJsonParsePayload` built so the arm's guard (evaluated by the real evaluator)
 * answers `wantPass`: the minimal instance first, then one and two member changes drawn from the guard's own
 * literals, a boolean's two values and an empty or one-element array. The payload unchanged when none answers.
 */
export function solveJsonParseFields(
  transition: { guard?: SExpr; effects?: ReadonlyArray<Effect> },
  wantPass: boolean,
  payload: EventPayload,
  types: DeclaredTypes,
  state: string,
  entityFields: ReadonlyArray<EntityFieldDef> = [],
): EventPayload {
  const guard = transition.guard;
  const fieldTypes = jsonParseFieldTypes(transition, types);
  if (guard === undefined || Object.keys(fieldTypes).length === 0) return payload;
  const instances: Record<string, Record<string, JsonLeaf>> = {};
  for (const field of Object.keys(fieldTypes)) {
    const raw = payload[field];
    if (typeof raw !== 'string') return payload;
    const parsed: JsonLeaf = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return payload;
    instances[field] = parsed;
  }
  const literals = new Set<string | number>();
  literalsOf(guard, literals);
  const answers = (candidate: Record<string, Record<string, JsonLeaf>>): boolean => {
    const next: EventPayload = { ...payload };
    for (const [field, instance] of Object.entries(candidate)) next[field] = JSON.stringify(instance);
    try {
      return guardPasses(guard, {}, next, state) === wantPass;
    } catch {
      return false;
    }
  };
  const elementOf = (typeName: string, member: string): JsonLeaf | undefined => {
    const declared = (types[typeName] ?? []).find((f) => f.name === member);
    const element = typeof declared?.type === 'string' ? /^\[(.+)\]$/.exec(declared.type)?.[1] : undefined;
    const elementType = element === undefined ? undefined : types[element];
    if (elementType === undefined) return undefined;
    const instance: JsonLeaf = JSON.parse(JSON.stringify(buildMinimalPayload(elementType.map(payloadFieldSpec), [...entityFields])));
    return instance;
  };
  const changes: Array<{ field: string; member: string; value: JsonLeaf }> = [];
  for (const [field, instance] of Object.entries(instances)) {
    for (const [member, current] of Object.entries(instance)) {
      const values: JsonLeaf[] = [];
      if (typeof current === 'boolean') values.push(!current);
      else if (Array.isArray(current)) {
        values.push([]);
        const element = elementOf(fieldTypes[field] ?? '', member);
        if (element !== undefined) values.push([element]);
      } else {
        for (const literal of literals) if (typeof literal === typeof current) values.push(literal);
        if (typeof current === 'number') values.push(0);
      }
      for (const value of values) if (JSON.stringify(value) !== JSON.stringify(current)) changes.push({ field, member, value });
    }
  }
  const apply = (...picked: typeof changes): Record<string, Record<string, JsonLeaf>> => {
    const copy: Record<string, Record<string, JsonLeaf>> = {};
    for (const [field, instance] of Object.entries(instances)) copy[field] = { ...instance };
    for (const change of picked) copy[change.field][change.member] = change.value;
    return copy;
  };
  const attempts: Array<typeof changes> = [[]];
  for (const one of changes) attempts.push([one]);
  for (let i = 0; i < changes.length; i++) {
    for (let j = i + 1; j < changes.length; j++) {
      if (changes[i].field !== changes[j].field || changes[i].member !== changes[j].member) attempts.push([changes[i], changes[j]]);
    }
  }
  for (const picked of attempts) {
    const candidate = apply(...picked);
    if (answers(candidate)) {
      const solved: EventPayload = { ...payload };
      for (const [field, instance] of Object.entries(candidate)) solved[field] = JSON.stringify(instance);
      return solved;
    }
  }
  return payload;
}

/** A payload field typed `T.f`: its name, its source, and whether it is an array of them. */
export interface ProjectedPayloadField {
  name: string;
  from: FieldProjection;
  array: boolean;
}

/** The payload's `T.f`-typed fields (`projectedFrom`), in declaration order. */
export function projectedPayloadFields(payloadSchema: ReadonlyArray<PayloadField> | undefined): ProjectedPayloadField[] {
  return (payloadSchema ?? []).flatMap((f) =>
    f.projectedFrom === undefined
      ? []
      : [{ name: f.name, from: f.projectedFrom, array: payloadTypeContainer(f.type).kind === 'array' }],
  );
}

/**
 * Fill each `T.f` field from a seeded `T` row — its `f` (wrapped in an array for an array
 * field) — so a filter or lookup keyed by it matches real data. A target with no seeded rows
 * leaves the synthesized value. Twin of orbital-verify `synth_field`'s projection rule.
 */
export async function applyProjectedPayload(
  payload: EventPayload,
  fields: ReadonlyArray<ProjectedPayloadField>,
  rowsFor: (entity: string) => Promise<ReadonlyArray<EntityRow>>,
): Promise<EventPayload> {
  const out: EventPayload = { ...payload };
  for (const field of fields) {
    const [row] = await rowsFor(field.from.type);
    if (row === undefined) continue;
    const value = row[field.from.field] ?? null;
    out[field.name] = field.array ? [value] : value;
  }
  return out;
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
