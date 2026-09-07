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

/**
 * Every field on `entityName` whose declared relation target IS
 * `entityName` itself AND whose delete rule actually blocks a delete —
 * `onDelete` defaults to `'restrict'` when undeclared (mirrors
 * `OrbitalServerRuntime.enforceOnDeleteRules`'s own `field.relation.onDelete
 * || 'restrict'` default EXACTLY — C1-V10 item 2 — the previous version
 * unconditionally avoided every self-relation field, including a
 * `cascade`/`nullify` one that never blocks a delete at all: a NEEDLESS
 * avoidance that could exhaust genuinely-deletable rows in
 * {@link pickBindableRow}'s search). Empty when the entity declares no
 * (restrict-rule) self-relation (the common case) — callers treat that as
 * "no avoidance needed."
 */
export function selfRelationFieldNames(schema: OrbitalSchema, entityName: string): string[] {
  const out: string[] = [];
  for (const def of inlineEntities(schema)) {
    if (def.name !== entityName) continue;
    for (const field of def.fields ?? []) {
      if (
        field.type === 'relation' &&
        field.relation.entity === entityName &&
        field.name !== undefined &&
        (field.relation.onDelete ?? 'restrict') === 'restrict' &&
        !out.includes(field.name)
      ) {
        out.push(field.name);
      }
    }
  }
  return out;
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

/**
 * The row `tick()` should target: the FIRST row (stable structural
 * position, the existing convention every row-picker in this package
 * uses) that no OTHER row in the same set references through any of
 * `avoidReferencedVia`'s fields — a proper reachability check over the
 * self-relation edges (see {@link directlyReferencedRowIds}), not just a
 * single scalar field read. Falls back to the first row outright when
 * `avoidReferencedVia` is empty (the entity has no restrict-rule self-
 * relation — nothing to avoid) or every row is referenced by some other
 * row (a fully-connected seed; picking the first is no worse than before,
 * and still surfaces the SAME restrict-rule rejection as a genuine finding
 * rather than silently retrying) — UNLESS `options.requireUnreferenced` is
 * `true`, in which case the fully-connected case returns `undefined`
 * instead of that fallback.
 *
 * `requireUnreferenced` exists for callers (C1-V11: `tick()`'s crud-edit/
 * crud-delete row resolution) that must fail a frame CLOSED rather than
 * knowingly click a row the runtime's own `onDelete: restrict` rule will
 * reject — silently falling back to row 0 there reproduces the exact bug
 * this module exists to fix. `bindRowFrom`'s existing call site (C1-V9/V10)
 * keeps the old "last resort, no worse than before" behavior by omitting
 * `options` — its contract is locked in by the tests below and is
 * unaffected by this addition.
 */
export function pickBindableRow(
  rows: ReadonlyArray<EntityRow>,
  avoidReferencedVia: ReadonlyArray<string> | undefined,
  options?: { requireUnreferenced?: boolean },
): EntityRow | undefined {
  if (rows.length === 0) return undefined;
  if (avoidReferencedVia === undefined || avoidReferencedVia.length === 0) return rows[0];

  const referencedIds = directlyReferencedRowIds(rows, avoidReferencedVia);
  const unreferenced = rows.find((row) => typeof row['id'] === 'string' && !referencedIds.has(row['id'] as string));
  if (unreferenced !== undefined) return unreferenced;
  return options?.requireUnreferenced === true ? undefined : rows[0];
}

/**
 * C1-V12 (rung 3): server-truth-aware generalization of
 * {@link pickBindableRow}. `entitiesBefore` (what every caller above used
 * to pass as `rows`) is the BROWSER's previous-frame snapshot of a
 * trait's fetched `data` — a filtered/paged SUBSET of the runtime's real
 * mock store — so computing referential safety over it alone can miss an
 * edge from a row the page never rendered (a hidden sibling referencing
 * a visible candidate via `avoidReferencedVia`), or flag a visible row as
 * "referenced" by a row that, on the full graph, doesn't exist. Both
 * misjudge exactly the `onDelete: restrict` check the runtime itself
 * enforces over its COMPLETE store.
 *
 * `serverRows` is the driver's `listEntityRows` result (the full store);
 * `visibleRows` is the existing browser-snapshot subset. When
 * `options.requireVisible` is true (a DOM-driven crud step — the click
 * can only ever land on a row the current page actually rendered) the
 * PICK is restricted to `visibleRows`, but the referential-safety check
 * is still computed over `serverRows`; otherwise (a bus-dispatched
 * `bindRowFrom` preamble, whose payload carries the id directly and
 * needs no rendered affordance) the pick draws from `serverRows`
 * outright, so a page with ZERO visible rows of the entity still
 * resolves a real target instead of the old "no row key" failure.
 *
 * `serverRows === visibleRows` (a driver with no `listEntityRows` — the
 * caller passes the same browser-snapshot array for both) reproduces
 * `pickBindableRow`'s exact pre-existing behavior; this function is a
 * strict generalization; never a behavior change for that fallback.
 *
 * Returns the row on success, or a `reason` string identifying which
 * constraint emptied the candidate set — folded into `tick()`'s
 * `no-target-row` finding instead of a bare "no row available".
 *
 * `options.isEnabled` (C1-V15 item B): a DOM-driven crud step must target
 * a row whose affordance is actually clickable — a row for which the
 * predicate returns `false` (the affordance's own `disabled` expression
 * evaluated `true` for that row, `tick()`'s job via `@almadar/evaluator`)
 * is dropped from the candidate set BEFORE the referential-safety check
 * runs, using the SAME message-emitting contract as every other exhausted-
 * candidate case here. Referential safety itself is unaffected — it is
 * always computed over the full `serverRows`, an affordance being disabled
 * has no bearing on whether some OTHER row references this one.
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
  },
): { row: EntityRow } | { reason: string } {
  const base = options?.requireVisible === true ? visibleRows : serverRows;
  if (base.length === 0) {
    return {
      reason: options?.requireVisible === true
        ? 'no row is rendered on the current page for this entity'
        : 'no row exists in the server-truth store for this entity',
    };
  }

  const candidates = options?.isEnabled !== undefined ? base.filter(options.isEnabled) : base;
  if (candidates.length === 0) {
    return {
      reason: options?.disabledReason ?? "every visible row's affordance is disabled",
    };
  }

  if (avoidReferencedVia === undefined || avoidReferencedVia.length === 0) {
    return { row: candidates[0] as EntityRow };
  }

  // Referential safety is always computed over the FULL server-truth set
  // (never just `candidates`) — a row referenced only by a row outside
  // `candidates` (a sibling this page never rendered) still blocks a
  // delete the runtime's own onDelete: restrict rule enforces.
  const referencedIds = directlyReferencedRowIds(serverRows, avoidReferencedVia);
  const safe = candidates.find((row) => typeof row['id'] === 'string' && !referencedIds.has(row['id'] as string));
  if (safe !== undefined) return { row: safe };
  if (options?.requireUnreferenced === true) {
    return {
      reason: `every candidate row is referenced via ${JSON.stringify(avoidReferencedVia)} (checked against the ` +
        'full server-truth row set) — the runtime\'s own onDelete: restrict rule would reject every one',
    };
  }
  return { row: candidates[0] as EntityRow };
}
