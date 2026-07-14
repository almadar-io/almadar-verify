/**
 * Rabit V4 Phase 3 — dual-carry id integrity (`ORB_ID_*`), runtime-path mirror.
 *
 * The TypeScript twin of the Rust validator
 * `orbital-compiler/src/phases/validation/id_integrity.rs`. Same four rules,
 * same codes, same severities; a deliberately corrupted `.orb` fails on BOTH
 * paths with the same code. Fully silent on legacy id-free schemas (no id
 * fields populated + no `schema.ledger` ⇒ nothing to walk).
 *
 * - `ORB_ID_UNKNOWN_REF` (error) — a populated dual-carry id points at neither
 *   a declared arena node nor a `schema.ledger` entry.
 * - `ORB_ID_NAME_MISMATCH` (error) — a reference carries BOTH a name and its id
 *   sibling, but the ledger's `curName` for that id disagrees with the name.
 * - `ORB_ID_KIND_MISMATCH` (error) — an id's prefix kind (`idKindOf`) disagrees
 *   with the position it occupies.
 * - `ORB_ID_LEDGER_ORPHAN` (warning) — a ledger row no node carries (stale).
 *
 * One id-index pass over the declarations builds the arena (`id → kind + name`
 * via declared nodes ∪ ledger); a single reference walk then applies rules 1–3
 * and records every id it sees; rule 4 diffs the ledger against that seen set.
 * An event ledger row is exempt from orphan detection while its owning trait id
 * (`parent`) is still live — event ids have no id-bearing declaration node, so
 * the parent trait is their carrier.
 *
 * @packageDocumentation
 */

import {
  KNOWN_VALIDATION_ERROR_CODES,
  idKindOf,
  idPrefix,
  isEntityCall,
  isEntityReference,
  isPageReferenceObject,
  isPageReferenceString,
  ledgerCurName,
  type EntityField,
  type IdentityLedger,
  type IdKind,
  type Orbital,
  type OrbitalSchema,
  type Page,
  type PageRefObject,
  type PageTraitRef,
  type Trait,
  type TraitRef,
  type TraitReference,
  type ValidationError,
  type ValidationResult,
} from '@almadar/core';

/** The `LedgerEntry.kind` set is a subset of `IdKind`; every position we check
 *  demands one of these five node kinds. */
type ArenaEntry = { kind: IdKind; name: string };

/**
 * Arena of declared node ids (`id → { kind, name }`) plus the ledger, shared by
 * all four rules. Mirrors the Rust `IdIndex`.
 */
class IdIndex {
  readonly ledger: IdentityLedger | undefined;
  readonly declared = new Map<string, ArenaEntry>();
  readonly traitIds = new Set<string>();

  constructor(schema: OrbitalSchema) {
    this.ledger = schema.ledger;
    for (const orbital of schema.orbitals) {
      if (orbital.id !== undefined) {
        this.declared.set(orbital.id, { kind: 'orbital', name: orbital.name });
      }
      this.declareEntity(orbital.entity);
      for (const aux of orbital.auxiliaryEntities ?? []) {
        this.declareEntity(aux);
      }
      for (const tr of orbital.traits) {
        this.declareTrait(tr);
      }
      for (const page of orbital.pages) {
        if (isInlinePage(page)) {
          if (page.id !== undefined) {
            this.declared.set(page.id, { kind: 'page', name: page.name });
          }
          // Inline page traits are reference-only (`PageTraitRef`) in the
          // `@almadar/core` model — they declare no ids of their own.
        }
      }
    }
  }

  private declareEntity(entity: Orbital['entity']): void {
    if (isEntityReference(entity) || isEntityCall(entity)) return;
    if (entity.id !== undefined) {
      this.declared.set(entity.id, { kind: 'entity', name: entity.name });
    }
  }

  private declareTrait(tr: TraitRef): void {
    if (!isInlineTrait(tr)) return;
    const td = tr;
    if (td.id !== undefined) {
      this.declared.set(td.id, { kind: 'trait', name: td.name });
      this.traitIds.add(td.id);
    }
    // Emits are the id-bearing declaration site for events.
    for (const emit of td.emits ?? []) {
      if (emit.eventId !== undefined) {
        this.declared.set(emit.eventId, { kind: 'event', name: emit.event });
      }
    }
    // `dataEntities` (`TraitDataEntity`) carry no id in the core model, and
    // their fields (`TraitEntityField`) carry no relation — no id surface.
  }

  /** An id is known if it is a declared arena node or a ledger entry. */
  known(id: string): boolean {
    return this.declared.has(id) || this.ledger?.entries[id] !== undefined;
  }

  curName(id: string): string | null {
    return this.ledger !== undefined ? ledgerCurName(this.ledger, id) : null;
  }
}

/** Inline `Page` guard — narrows a `PageRef` away from the string / object
 *  reference forms. */
function isInlinePage(page: Orbital['pages'][number]): page is Page {
  return !isPageReferenceString(page) && !isPageReferenceObject(page);
}

/**
 * A `TraitRef` object reference carries the dual-carry id siblings modelled by
 * `TraitReference` (`refId` / `linkedEntityId`). The bare-string and inline
 * `Trait` forms do not. `TraitReference` is assignable to `TraitRef`, so this
 * is a sound narrowing, not a cast.
 */
function isTraitReferenceObject(tr: TraitRef): tr is TraitReference {
  return typeof tr === 'object' && tr !== null && 'ref' in tr;
}

/** Inline `Trait` guard — the object form with no `ref` discriminator. `Trait`
 *  is a `TraitRef` member, so this is a sound narrowing, not a cast. */
function isInlineTrait(tr: TraitRef): tr is Trait {
  return typeof tr === 'object' && tr !== null && !('ref' in tr);
}

/** The in-file display name a `TraitRef` element resolves to (for a page
 *  object's `traitRefIds` mirror). */
function traitRefName(tr: TraitRef): string | undefined {
  if (typeof tr === 'string') return tr;
  if (isTraitReferenceObject(tr)) return tr.ref;
  return tr.name;
}

/**
 * Applies rules 1–3 at each reference position and records every id it sees.
 * Mirrors the Rust `Checker`.
 */
class Checker {
  constructor(
    private readonly index: IdIndex,
    private readonly errors: ValidationError[],
    private readonly seen: Set<string>,
  ) {}

  /**
   * Check one populated dual-carry id field. `expected` is the id kind the
   * position demands; `name` is the sibling name (for the dual-carry drift
   * check), `undefined`/dotted-path when there is nothing comparable in file.
   */
  private check(
    id: string | undefined,
    expected: IdKind,
    name: string | undefined,
    path: string,
  ): void {
    if (id === undefined) return;
    this.seen.add(id);

    // Rule 3 — kind prefix vs position.
    const kind = idKindOf(id);
    if (kind !== expected) {
      const got = kind !== null ? idPrefix(kind) : '<unknown>';
      this.errors.push({
        code: KNOWN_VALIDATION_ERROR_CODES.ORB_ID_KIND_MISMATCH,
        path,
        message: `id \`${id}\` has kind \`${got}\` but this position requires a \`${idPrefix(expected)}\` id.`,
      });
    }

    // Rule 1 — dangling edge. Only enforceable when the id layer is ACTIVE
    // (`schema.ledger` present). A ledger-less schema is name-authoritative
    // (dual-carry): populated id refs are then non-authoritative sugar, and a
    // reference to an inlined / cross-file node legitimately has no local arena
    // entry — with no ledger there is no id space to resolve it against. (Factory
    // orbitals carry baked id refs with no ledger; their names validate.)
    // Post-flip every schema carries a ledger, so this rule re-activates.
    if (this.index.ledger !== undefined && !this.index.known(id)) {
      this.errors.push({
        code: KNOWN_VALIDATION_ERROR_CODES.ORB_ID_UNKNOWN_REF,
        path,
        message: `id \`${id}\` matches no arena node nor ledger entry.`,
      });
    }

    // Rule 2 — dual-carry drift (only when the id resolves in the ledger and
    // the sibling is a bare in-file name; dotted alias paths are cross-file and
    // never carry an id under the minting contract).
    if (name !== undefined && !name.includes('.')) {
      const cur = this.index.curName(id);
      if (cur !== null && cur !== name) {
        this.errors.push({
          code: KNOWN_VALIDATION_ERROR_CODES.ORB_ID_NAME_MISMATCH,
          path,
          message: `name \`${name}\` disagrees with ledger curName \`${cur}\` for id \`${id}\`.`,
        });
      }
    }
  }

  walkOrbital(oi: number, orbital: Orbital): void {
    const op = `orbitals[${oi} (${orbital.name})]`;

    const entity = orbital.entity;
    if (isEntityCall(entity)) {
      this.check(entity.extendsId, 'entity', entity.extends, `${op}.entity.extends`);
    } else if (!isEntityReference(entity)) {
      this.walkEntity(entity.fields, `${op}.entity`);
    }
    const aux = orbital.auxiliaryEntities ?? [];
    for (let ai = 0; ai < aux.length; ai++) {
      const a = aux[ai];
      if (isEntityCall(a)) {
        this.check(a.extendsId, 'entity', a.extends, `${op}.auxiliaryEntities[${ai}].extends`);
      } else if (!isEntityReference(a)) {
        this.walkEntity(a.fields, `${op}.auxiliaryEntities[${ai}]`);
      }
    }

    for (let ti = 0; ti < orbital.traits.length; ti++) {
      this.walkTraitRef(orbital.traits[ti], `${op}.traits[${ti}]`);
    }

    for (let pi = 0; pi < orbital.pages.length; pi++) {
      const page = orbital.pages[pi];
      if (isInlinePage(page)) {
        const traits = page.traits ?? [];
        for (let ti = 0; ti < traits.length; ti++) {
          this.walkPageTraitRef(traits[ti], `${op}.pages[${pi} (${page.name})].traits[${ti}]`);
        }
      } else if (isPageReferenceObject(page)) {
        this.walkPageRefObject(page, `${op}.pages[${pi}]`);
      }
    }
  }

  private walkPageRefObject(o: PageRefObject, pp: string): void {
    this.check(o.refId, 'page', o.ref, `${pp}.ref`);
    this.check(o.linkedEntityId, 'entity', o.linkedEntity, `${pp}.linkedEntity`);
    const traits = o.traits ?? [];
    if (o.traitRefIds !== undefined) {
      for (let ti = 0; ti < o.traitRefIds.length; ti++) {
        const rid = o.traitRefIds[ti];
        if (rid === undefined || rid.length === 0) continue;
        const name = ti < traits.length ? traitRefName(traits[ti]) : undefined;
        this.check(rid, 'trait', name, `${pp}.traitRefIds[${ti}]`);
      }
    }
    for (let ti = 0; ti < traits.length; ti++) {
      this.walkTraitRef(traits[ti], `${pp}.traits[${ti}]`);
    }
  }

  private walkEntity(fields: EntityField[], path: string): void {
    for (let fi = 0; fi < fields.length; fi++) {
      this.walkFieldRelations(fields[fi], `${path}.fields[${fi}]`);
    }
  }

  private walkFieldRelations(field: EntityField, path: string): void {
    if (field.type === 'relation') {
      this.check(field.relation.entityId, 'entity', field.relation.entity, `${path}.relation`);
    }
    if ((field.type === 'array' || field.type === 'object') && field.items !== undefined) {
      this.walkFieldRelations(field.items, `${path}.items`);
    }
    if (field.properties !== undefined) {
      for (const [k, p] of Object.entries(field.properties)) {
        this.walkFieldRelations(p, `${path}.properties.${k}`);
      }
    }
  }

  /** A page's inline trait entry (`PageTraitRef`) — reference form only. */
  private walkPageTraitRef(pt: PageTraitRef, path: string): void {
    this.check(pt.refId, 'trait', pt.ref, `${path}.ref`);
    this.check(pt.linkedEntityId, 'entity', pt.linkedEntity, `${path}.linkedEntity`);
  }

  private walkTraitRef(tr: TraitRef, path: string): void {
    if (typeof tr === 'string') return;
    if (isTraitReferenceObject(tr)) {
      // Reference form — carries the dual-carry siblings via `TraitReference`.
      this.check(tr.refId, 'trait', tr.ref, `${path}.ref`);
      this.check(tr.linkedEntityId, 'entity', tr.linkedEntity, `${path}.linkedEntity`);
      return;
    }
    if (!isInlineTrait(tr)) return;
    const td = tr;
    this.check(td.linkedEntityId, 'entity', td.linkedEntity, `${path}.linkedEntity`);
    const emits = td.emits ?? [];
    for (let ei = 0; ei < emits.length; ei++) {
      const emit = emits[ei];
      this.check(emit.eventId, 'event', emit.event, `${path}.emits[${ei} (${emit.event})]`);
    }
    const listens = td.listens ?? [];
    for (let li = 0; li < listens.length; li++) {
      const listen = listens[li];
      const lp = `${path}.listens[${li}]`;
      this.check(listen.eventId, 'event', listen.event, `${lp}.event`);
      this.check(listen.triggersId, 'event', listen.triggers, `${lp}.triggers`);
      const source = listen.source;
      if (source !== undefined && source.kind === 'trait') {
        this.check(source.traitId, 'trait', source.trait, `${lp}.source.trait`);
      } else if (source !== undefined && source.kind === 'orbital') {
        this.check(source.orbitalId, 'orbital', source.orbital, `${lp}.source.orbital`);
        this.check(source.traitId, 'trait', source.trait, `${lp}.source.trait`);
      }
    }
    // `dataEntities` carry no id surface in the core model (see IdIndex).
  }
}

/**
 * Rule family entry point — the runtime-path mirror of the Rust
 * `validate_id_integrity`. Returns a canonical `@almadar/core`
 * `ValidationResult` (`ok` iff zero errors AND zero warnings). The orphan rule
 * lands in `warnings` (non-blocking, matching the Rust `phase_f_warning`); a
 * caller gating on "blocks validation" reads `errors.length === 0`.
 * No-op on legacy id-free schemas.
 */
export function validateIdIntegrity(schema: OrbitalSchema): ValidationResult {
  const index = new IdIndex(schema);
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const seen = new Set<string>(index.declared.keys());

  const checker = new Checker(index, errors, seen);
  for (let oi = 0; oi < schema.orbitals.length; oi++) {
    checker.walkOrbital(oi, schema.orbitals[oi]);
  }

  // Rule 4 — ledger rows no node carries. An event row is carried by its owning
  // (parent) trait while that trait is live, since event ids have no id-bearing
  // declaration node of their own.
  const ledger = schema.ledger;
  if (ledger !== undefined) {
    for (const entry of Object.values(ledger.entries)) {
      const carried =
        seen.has(entry.id) ||
        (entry.kind === 'event' &&
          entry.parent !== undefined &&
          index.traitIds.has(entry.parent));
      if (!carried) {
        warnings.push({
          code: KNOWN_VALIDATION_ERROR_CODES.ORB_ID_LEDGER_ORPHAN,
          path: `ledger.entries[${entry.id}]`,
          message: `ledger row \`${entry.id}\` (kind \`${entry.kind}\`, curName \`${entry.curName}\`) is carried by no node in the schema — stale.`,
        });
      }
    }
  }

  return { ok: errors.length === 0 && warnings.length === 0, errors, warnings };
}
