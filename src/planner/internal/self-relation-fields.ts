/**
 * `self-relation-fields` — C1-V9 item B follow-on: which of an entity's OWN
 * fields relate back to that SAME entity (a tree/self-reference shape, e.g.
 * `Note.parentId : Note`, or the record-detail/modal generic's rewritten
 * self-relation `Employee.seedRow : Employee` — see `ownerFieldsFromSchema`'s
 * doc). A row referenced by another row through one of these fields cannot
 * be deleted under an `onDelete: restrict` rule — the mock seeder's
 * self-referential tree shape (`MockPersistenceAdapter.linkRelationFields`:
 * "row 0 stays a root, row i parents to row ⌊(i−1)/2⌋") makes row 0
 * (`entitiesBefore[entity]?.[0]`, the row every OTHER row-picker in this
 * package defaults to) a root with children EVERY time — so a `persist
 * delete` step that blindly targets row 0 hits the SAME referential-
 * integrity rejection on every self-referential entity, never the
 * ownership/access-policy question C1-V9 items A/B actually fixed.
 *
 * C1-V10 item 2: the original `pickBindableRow` only read a SCALAR field
 * value and never filtered by the field's own `onDelete` rule — both fixed
 * below, mirroring `OrbitalServerRuntime.enforceOnDeleteRules`'s own field
 * reader so a row this module judges "safe" never disagrees with what the
 * real runtime's restrict enforcement actually checks.
 *
 * Pure. No `Page`, no driver, no live entity data.
 *
 * @packageDocumentation
 */

import type { OrbitalSchema, OrbitalEntity, EntityRow } from '@almadar/core';

/** Inline entity definitions of an orbital: the primary plus any auxiliaries. */
function inlineEntities(schema: OrbitalSchema): OrbitalEntity[] {
  const out: OrbitalEntity[] = [];
  for (const orbital of schema.orbitals ?? []) {
    const refs = [orbital.entity, ...(orbital.auxiliaryEntities ?? [])];
    for (const ref of refs) {
      if (typeof ref === 'object' && ref !== null && 'fields' in ref) {
        out.push(ref as OrbitalEntity);
      }
    }
  }
  return out;
}

/** One `(entityName, fieldName)` relation field, ANYWHERE in the schema,
 *  whose target is the entity a delete is being planned for and whose own
 *  `onDelete` rule actually blocks that delete. */
export interface InboundRestrictRelation {
  /** The entity DECLARING the relation field (the one whose rows reference
   *  the delete target — may be the target entity itself, the self-
   *  relation case, or any other entity in the schema). */
  entityName: string;
  fieldName: string;
}

/**
 * Every `(entityName, fieldName)` relation field in the WHOLE schema whose
 * declared relation target is `targetEntityName` AND whose delete rule
 * actually blocks a delete — the ONE owner mirroring
 * `OrbitalServerRuntime.enforceOnDeleteRules`'s own scan EXACTLY: that
 * function loops over every REGISTERED entity's fields looking for
 * `field.relation.entity === entityType` (the entity being deleted), not
 * just `targetEntityName`'s own fields — a cross-entity inbound restrict
 * (`ChatMessage.channel : Channel`, blocking a `Channel` delete) is just as
 * real a block as a self-relation (`Note.parentId : Note`) is, and the
 * planner previously only ever knew about the latter. `onDelete` defaults
 * to `'restrict'` when undeclared, same default `enforceOnDeleteRules`
 * applies (C1-V10 item 2, preserved here).
 */
export function inboundRestrictRelations(
  schema: OrbitalSchema,
  targetEntityName: string,
): InboundRestrictRelation[] {
  const out: InboundRestrictRelation[] = [];
  for (const def of inlineEntities(schema)) {
    for (const field of def.fields ?? []) {
      if (
        field.type === 'relation' &&
        field.relation.entity === targetEntityName &&
        field.name !== undefined &&
        (field.relation.onDelete ?? 'restrict') === 'restrict'
      ) {
        out.push({ entityName: def.name, fieldName: field.name });
      }
    }
  }
  return out;
}

/**
 * The SELF-relation slice of {@link inboundRestrictRelations} — field names
 * on `entityName` that relate back to `entityName` itself (`Note.parentId`,
 * the record-detail generic's rewritten `seedRow`). Empty when the entity
 * declares no (restrict-rule) self-relation (the common case) — callers
 * treat that as "no avoidance needed."
 */
export function selfRelationFieldNames(schema: OrbitalSchema, entityName: string): string[] {
  const out: string[] = [];
  for (const rel of inboundRestrictRelations(schema, entityName)) {
    if (rel.entityName === entityName && !out.includes(rel.fieldName)) out.push(rel.fieldName);
  }
  return out;
}

/**
 * The CROSS-entity slice of {@link inboundRestrictRelations} — every
 * `(entityName, fieldName)` pair belonging to some OTHER entity that
 * references `targetEntityName` with a restrict rule (`ChannelMember.channel
 * : Channel`, `ChatMessage.channel : Channel` both blocking a `Channel`
 * delete). Excludes the self-relation slice `selfRelationFieldNames` already
 * owns. Empty when nothing outside the entity itself ever restricts its
 * delete — the common case.
 */
export function crossEntityRestrictRelations(
  schema: OrbitalSchema,
  targetEntityName: string,
): InboundRestrictRelation[] {
  return inboundRestrictRelations(schema, targetEntityName).filter((rel) => rel.entityName !== targetEntityName);
}

/**
 * Every row id that is DIRECTLY referenced, through any field in
 * `viaFields`, by at least one row in `rows` — i.e. every row that has at
 * least one child. A row's presence here already proves it has a
 * descendant chain, however deep (a node with a grandchild necessarily has
 * a child too), so this ONE pass over the edge set answers the reachability
 * question {@link pickBindableRow} needs for a tree of ANY depth —
 * "grandchild → child → root" is caught the same way "child → root" is,
 * both reduce to "is this id someone's direct parent."
 *
 * C1-V10 item 2: reads a field's value the SAME way
 * `OrbitalServerRuntime.enforceOnDeleteRules` does — `Array.isArray(fkValue)
 * ? fkValue.includes(id) : fkValue === id` — so a `many`/`one-to-many`/
 * `many-to-many` self-relation (an array-of-ids value, e.g.
 * `relatedIds : [Note]`) is honored too. The previous version's
 * `typeof value === 'string'` guard silently skipped every array-valued
 * self-relation: a row `pickBindableRow` judged "safe" (zero SCALAR
 * children) could still carry array-referenced children the real runtime's
 * restrict check WOULD reject — the exact "still blocked by restrict"
 * failure mode this item fixes.
 */
function directlyReferencedRowIds(
  rows: ReadonlyArray<EntityRow>,
  viaFields: ReadonlyArray<string>,
): ReadonlySet<string> {
  const referenced = new Set<string>();
  for (const row of rows) {
    for (const field of viaFields) {
      const value = row[field];
      if (typeof value === 'string' && value.length > 0) {
        referenced.add(value);
      } else if (Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === 'string' && entry.length > 0) referenced.add(entry);
        }
      }
    }
  }
  return referenced;
}

/** One OTHER entity's rows plus the field on them that may reference the
 *  row being picked — {@link pickTargetRow}'s cross-entity input, one entry
 *  per {@link crossEntityRestrictRelations} pair the caller resolved to
 *  live rows (`tick()`'s `serverRowsFor`). */
export interface CrossEntityReferenceRows {
  field: string;
  rows: ReadonlyArray<EntityRow>;
}

/** Why {@link pickTargetRow} returned no row — folded into `tick()`'s
 *  finding message: `'no-rows'` (the base set itself is empty), `'all-
 *  disabled'` (every candidate's affordance is disabled), `'all-referenced'`
 *  (every candidate is referenced — self-relation or cross-entity — and
 *  `requireUnreferenced` was set). */
export type PickTargetRowFailureCode = 'no-rows' | 'all-disabled' | 'all-referenced';

/**
 * The row `tick()` should target: the FIRST row (stable structural
 * position, the existing convention every row-picker in this package uses)
 * that no OTHER row references through any of `avoidReferencedVia`'s
 * SELF-relation fields, nor any row of a DIFFERENT entity references
 * through one of `options.crossEntity`'s fields — a proper reachability
 * check over every restrict-rule edge `OrbitalServerRuntime.
 * enforceOnDeleteRules` would enforce (see {@link directlyReferencedRowIds}
 * and {@link inboundRestrictRelations}), not just a same-entity scalar
 * field read.
 *
 * `entitiesBefore` (what a caller may pass as `visibleRows`) is the
 * BROWSER's previous-frame snapshot of a trait's fetched `data` — a
 * filtered/paged SUBSET of the runtime's real mock store — so computing
 * referential safety over it alone can miss an edge from a row the page
 * never rendered, or flag a visible row as "referenced" by a row that, on
 * the full graph, doesn't exist. `serverRows` (the driver's
 * `listEntityRows` result, the full store) is what the referential-safety
 * check is always computed over; `serverRows === visibleRows` (a driver
 * with no `listEntityRows`) is the degenerate case, not a special one.
 *
 * `options.requireVisible` restricts the PICK itself to `visibleRows` (a
 * DOM-driven crud step — the click can only ever land on a row the current
 * page actually rendered); otherwise (a bus-dispatched `bindRowFrom`
 * preamble, whose payload carries the id directly and needs no rendered
 * affordance) the pick draws from `serverRows` outright, so a page with
 * ZERO visible rows of the entity still resolves a real target instead of a
 * "no row key" failure.
 *
 * `options.isEnabled` (C1-V15 item B): a DOM-driven crud step must target a
 * row whose affordance is actually clickable — a row for which the
 * predicate returns `false` (the affordance's own `disabled` expression
 * evaluated `true` for that row, `tick()`'s job via `@almadar/evaluator`)
 * is dropped from the candidate set BEFORE the referential-safety check
 * runs. Referential safety itself is unaffected — it is always computed
 * over the full `serverRows` (+ `options.crossEntity`'s rows), an
 * affordance being disabled has no bearing on whether some OTHER row
 * references this one.
 *
 * Falls back to the first (enabled) candidate outright when NEITHER
 * `avoidReferencedVia` nor `options.crossEntity` names anything to avoid,
 * or when every candidate is referenced (a fully-connected seed; picking
 * the first is no worse than before, and still surfaces the SAME
 * restrict-rule rejection as a genuine finding rather than silently
 * retrying) — UNLESS `options.requireUnreferenced` is `true`, in which case
 * the fully-connected case returns a `'all-referenced'`-coded failure
 * instead of that fallback (C1-V11: `tick()`'s crud-edit/crud-delete row
 * resolution must fail a frame CLOSED rather than knowingly click a row the
 * runtime's own `onDelete: restrict` rule will reject).
 */
export function pickTargetRow(
  serverRows: ReadonlyArray<EntityRow>,
  visibleRows: ReadonlyArray<EntityRow>,
  avoidReferencedVia: ReadonlyArray<string> | undefined,
  options?: {
    requireUnreferenced?: boolean;
    requireVisible?: boolean;
    isEnabled?: (row: EntityRow) => boolean;
    disabledReason?: string;
    /** C1-V17: OTHER entities' rows whose relation fields point at THIS
     *  pick's entity with a restrict rule (`crossEntityRestrictRelations`,
     *  resolved to live rows by the caller). */
    crossEntity?: ReadonlyArray<CrossEntityReferenceRows>;
  },
): { row: EntityRow } | { reason: string; code: PickTargetRowFailureCode } {
  const base = options?.requireVisible === true ? visibleRows : serverRows;
  if (base.length === 0) {
    return {
      code: 'no-rows',
      reason: options?.requireVisible === true
        ? 'no row is rendered on the current page for this entity'
        : 'no row exists in the server-truth store for this entity',
    };
  }

  const candidates = options?.isEnabled !== undefined ? base.filter(options.isEnabled) : base;
  if (candidates.length === 0) {
    return {
      code: 'all-disabled',
      reason: options?.disabledReason ?? "every visible row's affordance is disabled",
    };
  }

  const hasSelfAvoidance = avoidReferencedVia !== undefined && avoidReferencedVia.length > 0;
  const crossEntity = options?.crossEntity;
  const hasCrossEntityAvoidance = crossEntity !== undefined && crossEntity.length > 0;
  if (!hasSelfAvoidance && !hasCrossEntityAvoidance) {
    return { row: candidates[0] as EntityRow };
  }

  // Referential safety is always computed over the FULL server-truth set
  // (never just `candidates`) — a row referenced only by a row outside
  // `candidates` (a sibling this page never rendered) still blocks a
  // delete the runtime's own onDelete: restrict rule enforces. Cross-entity
  // references are checked against THEIR OWN entity's rows, not
  // `serverRows` (which only ever holds the pick's own entity).
  const referencedIds = new Set<string>(
    hasSelfAvoidance ? directlyReferencedRowIds(serverRows, avoidReferencedVia as ReadonlyArray<string>) : [],
  );
  if (hasCrossEntityAvoidance) {
    for (const ref of crossEntity as ReadonlyArray<CrossEntityReferenceRows>) {
      for (const id of directlyReferencedRowIds(ref.rows, [ref.field])) referencedIds.add(id);
    }
  }

  const safe = candidates.find((row) => typeof row['id'] === 'string' && !referencedIds.has(row['id'] as string));
  if (safe !== undefined) return { row: safe };
  if (options?.requireUnreferenced === true) {
    return {
      code: 'all-referenced',
      reason: 'every candidate row is referenced (checked against the full server-truth row set, including any '
        + "restrict-rule relation from another entity) — the runtime's own onDelete: restrict rule would reject every one",
    };
  }
  return { row: candidates[0] as EntityRow };
}
