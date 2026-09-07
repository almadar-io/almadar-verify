/**
 * Tests for the V4 dual-carry id-integrity mirror (`ORB_ID_*`).
 *
 * The runtime-path twin of the Rust `id_integrity.rs` unit tests: same
 * fixtures, same rule codes, same severities. A deliberately corrupted schema
 * must fail here with the SAME code the compiler emits.
 *
 * Fixtures are built as real typed `OrbitalSchema` object graphs (via the
 * branded `as*Id` constructors) rather than raw wire JSON, so every field —
 * including the deliberately corrupted ones — is honestly typed. The single
 * exception is `wrongKindId` below: constructing the one `ORB_ID_KIND_MISMATCH`
 * fixture genuinely requires a wrong-kind id (a `trt_` id in an `EntityId`
 * slot), which no `as*Id` constructor can produce since each validates its
 * own prefix. Its single-step assertion mirrors `identity.ts`'s own
 * (unexported) `brand()` helper — never `as unknown as`.
 */

import { describe, it, expect } from 'vitest';
import type {
  Entity,
  EntityId,
  IdentityLedger,
  LedgerEntry,
  Orbital,
  OrbitalId,
  OrbitalPage,
  OrbitalSchema,
  PageId,
  Trait,
  TraitEventContract,
  TraitEventListener,
  TraitId,
  ValidationResult,
} from '@almadar/core';
import { asEntityId, asEventId, asOrbitalId, asPageId, asTraitId } from '@almadar/core';
import { validateIdIntegrity } from '../id-integrity.js';

/** The one deliberate bypass of the `as*Id` constructors' own prefix check —
 *  needed to construct a wrong-kind id (the exact input `ORB_ID_KIND_MISMATCH`
 *  exists to catch). Single-step assertion: `Id extends string` is already a
 *  subtype of `string`, so this narrows in one step, never through `unknown`. */
function wrongKindId<Id extends string>(raw: string): Id {
  return raw as Id;
}

function ledgerEntry(id: string, kind: LedgerEntry['kind'], name: string, parent?: TraitId): LedgerEntry {
  return { id, kind, bakedName: name, curName: name, renames: [], owner: 'workspace', ...(parent === undefined ? {} : { parent }) };
}

/** Fresh, fully-typed "healthy stamped schema" fixture: one orbital, inline
 *  entity, one inline trait with a linked entity + emit + listen (with
 *  source), one page, full ledger. Every named part is returned alongside
 *  the assembled `schema` so a test can mutate it directly (delete an id
 *  field, drift a name, add a ledger row) with no re-cast needed — `schema`
 *  shares the same object references throughout. Called fresh per test in
 *  place of a JSON clone. */
function buildHealthy() {
  const orbitalId = asOrbitalId('orb_TASK000000000000000000000');
  const entityId = asEntityId('ent_TASK000000000000000000000');
  const traitId = asTraitId('trt_LIST000000000000000000000');
  const refreshEventId = asEventId('evt_REFRESH0000000000000000');
  const pingEventId = asEventId('evt_PING0000000000000000000');
  const pageId = asPageId('pag_HOME000000000000000000000');

  const entity: Entity = {
    name: 'Task',
    id: entityId,
    fields: [{ name: 'title', type: 'string' }],
  };
  const refreshEmit: TraitEventContract = { event: 'REFRESH', eventId: refreshEventId };
  const pingListen: TraitEventListener = {
    event: 'PING',
    eventId: pingEventId,
    triggers: 'REFRESH',
    triggersId: refreshEventId,
    source: { kind: 'trait', trait: 'TaskList', traitId },
  };
  const trait: Trait = {
    name: 'TaskList',
    id: traitId,
    scope: 'collection',
    linkedEntity: 'Task',
    linkedEntityId: entityId,
    emits: [refreshEmit],
    listens: [pingListen],
  };
  const page: OrbitalPage = { name: 'Home', id: pageId, path: '/' };
  const orbital: Orbital = {
    name: 'TaskOrbital',
    id: orbitalId,
    entity,
    traits: [trait],
    pages: [page],
  };
  const ledger: IdentityLedger = {
    schemaVersion: 1,
    entries: {
      [orbitalId]: ledgerEntry(orbitalId, 'orbital', 'TaskOrbital'),
      [entityId]: ledgerEntry(entityId, 'entity', 'Task'),
      [traitId]: ledgerEntry(traitId, 'trait', 'TaskList'),
      [refreshEventId]: ledgerEntry(refreshEventId, 'event', 'REFRESH', traitId),
      [pingEventId]: ledgerEntry(pingEventId, 'event', 'PING', traitId),
      [pageId]: ledgerEntry(pageId, 'page', 'Home'),
    },
  };
  const schema: OrbitalSchema = { name: 'TestApp', orbitals: [orbital], schemaVersion: 1, ledger };

  return { schema, orbital, entity, trait, page, refreshEmit, pingListen, ledger, traitId, entityId };
}

/** Every `ORB_ID_*` code the result carries, errors then warnings. */
function idCodes(result: ValidationResult): string[] {
  return [...result.errors, ...result.warnings]
    .map((e) => e.code)
    .filter((c) => c.startsWith('ORB_ID_'));
}

describe('validateIdIntegrity', () => {
  it('is silent on a healthy stamped schema', () => {
    const { schema } = buildHealthy();
    const result = validateIdIntegrity(schema);
    expect(idCodes(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('is silent on a legacy id-free schema', () => {
    const { schema, orbital, entity, trait, page, refreshEmit, pingListen } = buildHealthy();
    delete orbital.id;
    delete entity.id;
    delete trait.id;
    delete trait.linkedEntityId;
    delete refreshEmit.eventId;
    delete pingListen.eventId;
    delete pingListen.triggersId;
    if (pingListen.source?.kind === 'trait') delete pingListen.source.traitId;
    delete page.id;
    delete schema.ledger;
    delete schema.schemaVersion;

    const result = validateIdIntegrity(schema);
    expect(idCodes(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('fires ORB_ID_UNKNOWN_REF on a dangling id', () => {
    const { schema, trait } = buildHealthy();
    // Well-formed Entity id, absent from arena + ledger.
    trait.linkedEntityId = asEntityId('ent_GHOST00000000000000000000');
    expect(idCodes(validateIdIntegrity(schema))).toEqual(['ORB_ID_UNKNOWN_REF']);
  });

  it('fires ORB_ID_UNKNOWN_REF on a dangling entityRefIds id (orbital-import stale side-map)', () => {
    // Pins the orbital-import defect this rule was added for: a stale
    // `entityRefIds` entry whose value is a FOREIGN id (belongs to no node
    // in this schema's arena/ledger — exactly what a materialization splice
    // leaves behind when it renames the trait's body tokens + `linkedEntity`
    // but never touches the side-map) is a dangling ref, same as any other
    // dual-carry sibling.
    const { schema, trait } = buildHealthy();
    trait.entityRefIds = { UpstreamTask: asEntityId('ent_GHOST00000000000000000000') };
    expect(idCodes(validateIdIntegrity(schema))).toEqual(['ORB_ID_UNKNOWN_REF']);
  });

  it('does not fire ORB_ID_NAME_MISMATCH on a stale entityRefIds key with a live id', () => {
    // A stale `entityRefIds` KEY (naming an old display name) whose VALUE
    // still resolves to a live, correctly-kinded id in this schema must NOT
    // fire `ORB_ID_NAME_MISMATCH` — `orbital_core::stamp`'s documented
    // contract tolerates the key staying old across a same-schema, same-id
    // declaration rename (resolved transparently by id), so a key/curName
    // drift alone is not a defect for this side-map.
    const { schema, trait, entityId } = buildHealthy();
    trait.entityRefIds = { OldTaskName: entityId };
    expect(idCodes(validateIdIntegrity(schema))).toEqual([]);
  });

  it('is silent on populated id refs when there is NO ledger (G-V4-1: factory orb, id layer inactive)', () => {
    // Factory-instantiated orbitals carry baked id refs but no ledger. With no
    // ledger the id layer is inactive (dual-carry: names authoritative), so a
    // ref with no local arena entry must NOT fire ORB_ID_UNKNOWN_REF.
    const { schema, trait } = buildHealthy();
    trait.linkedEntityId = asEntityId('ent_GHOST00000000000000000000');
    delete schema.ledger;
    const result = validateIdIntegrity(schema);
    expect(idCodes(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('fires ORB_ID_NAME_MISMATCH on dual-carry drift', () => {
    const { schema, refreshEmit } = buildHealthy();
    // id still resolves in the ledger (curName REFRESH), but the name drifts.
    refreshEmit.event = 'RELOAD';
    expect(idCodes(validateIdIntegrity(schema))).toEqual(['ORB_ID_NAME_MISMATCH']);
  });

  it('fires ORB_ID_KIND_MISMATCH on a wrong-prefix id', () => {
    const { schema, trait, ledger } = buildHealthy();
    // A Trait id in the entity `linkedEntityId` position, kept name-agreeing via
    // a ledger row so ONLY the kind rule fires.
    const wrongId = wrongKindId<EntityId>('trt_TASKENT00000000000000000');
    trait.linkedEntityId = wrongId;
    ledger.entries[wrongId] = ledgerEntry(wrongId, 'trait', 'Task');
    expect(idCodes(validateIdIntegrity(schema))).toEqual(['ORB_ID_KIND_MISMATCH']);
  });

  it('fires ORB_ID_LEDGER_ORPHAN as a non-blocking warning', () => {
    const { schema, ledger } = buildHealthy();
    const ghostId = asEntityId('ent_GHOST00000000000000000000');
    ledger.entries[ghostId] = ledgerEntry(ghostId, 'entity', 'Ghost');
    const result = validateIdIntegrity(schema);
    expect(idCodes(result)).toEqual(['ORB_ID_LEDGER_ORPHAN']);
    // Orphan is a warning: it does not block validation (zero errors).
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
  });

  it('exempts an event ledger row while its parent trait lives', () => {
    const { schema, ledger, traitId } = buildHealthy();
    const internalEventId = asEventId('evt_INTERNAL00000000000000');
    ledger.entries[internalEventId] = ledgerEntry(internalEventId, 'event', 'TICK', traitId);
    // Event row with no id field carrying it, but a live parent trait → not orphan.
    expect(idCodes(validateIdIntegrity(schema))).toEqual([]);
  });
});
