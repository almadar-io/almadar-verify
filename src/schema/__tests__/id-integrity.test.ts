/**
 * Tests for the V4 dual-carry id-integrity mirror (`ORB_ID_*`).
 *
 * The runtime-path twin of the Rust `id_integrity.rs` unit tests: same
 * fixtures, same rule codes, same severities. A deliberately corrupted schema
 * must fail here with the SAME code the compiler emits.
 *
 * Fixtures are authored as `.orb` wire JSON and converted at the boundary
 * (`parse`) — the TypeScript analog of Rust's `serde_json::from_value`, and the
 * only place a cast lives (the production module is cast-free). This is how the
 * package's other schema fixtures are built (see `assert-click-no-listener`).
 */

import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, ValidationResult } from '@almadar/core';
import { validateIdIntegrity } from '../id-integrity.js';

/** Healthy stamped schema: one orbital, inline entity, one inline trait with a
 *  linked entity + emit + listen (with source), one page, full ledger. */
function healthyJson(): Record<string, unknown> {
  return {
    name: 'TestApp',
    orbitals: [
      {
        name: 'TaskOrbital',
        id: 'orb_TASK000000000000000000000',
        entity: {
          name: 'Task',
          id: 'ent_TASK000000000000000000000',
          fields: [{ name: 'title', type: 'string' }],
        },
        traits: [
          {
            name: 'TaskList',
            id: 'trt_LIST000000000000000000000',
            scope: 'collection',
            linkedEntity: 'Task',
            linkedEntityId: 'ent_TASK000000000000000000000',
            emits: [{ event: 'REFRESH', eventId: 'evt_REFRESH0000000000000000' }],
            listens: [
              {
                event: 'PING',
                eventId: 'evt_PING0000000000000000000',
                triggers: 'REFRESH',
                triggersId: 'evt_REFRESH0000000000000000',
                source: {
                  kind: 'trait',
                  trait: 'TaskList',
                  traitId: 'trt_LIST000000000000000000000',
                },
              },
            ],
          },
        ],
        pages: [{ name: 'Home', id: 'pag_HOME000000000000000000000', path: '/' }],
      },
    ],
    schemaVersion: 1,
    ledger: {
      schemaVersion: 1,
      entries: {
        orb_TASK000000000000000000000: { id: 'orb_TASK000000000000000000000', kind: 'orbital', bakedName: 'TaskOrbital', curName: 'TaskOrbital', renames: [], owner: 'workspace' },
        ent_TASK000000000000000000000: { id: 'ent_TASK000000000000000000000', kind: 'entity', bakedName: 'Task', curName: 'Task', renames: [], owner: 'workspace' },
        trt_LIST000000000000000000000: { id: 'trt_LIST000000000000000000000', kind: 'trait', bakedName: 'TaskList', curName: 'TaskList', renames: [], owner: 'workspace' },
        evt_REFRESH0000000000000000: { id: 'evt_REFRESH0000000000000000', kind: 'event', bakedName: 'REFRESH', curName: 'REFRESH', renames: [], owner: 'workspace', parent: 'trt_LIST000000000000000000000' },
        evt_PING0000000000000000000: { id: 'evt_PING0000000000000000000', kind: 'event', bakedName: 'PING', curName: 'PING', renames: [], owner: 'workspace', parent: 'trt_LIST000000000000000000000' },
        pag_HOME000000000000000000000: { id: 'pag_HOME000000000000000000000', kind: 'page', bakedName: 'Home', curName: 'Home', renames: [], owner: 'workspace' },
      },
    },
  };
}

/** Deep-clone a mutable wire fixture. */
function clone(v: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(v);
}

/** The wire → typed boundary, mirroring Rust's `serde_json::from_value`. */
function parse(v: Record<string, unknown>): OrbitalSchema {
  return v as unknown as OrbitalSchema;
}

/** Every `ORB_ID_*` code the result carries, errors then warnings. */
function idCodes(result: ValidationResult): string[] {
  return [...result.errors, ...result.warnings]
    .map((e) => e.code)
    .filter((c) => c.startsWith('ORB_ID_'));
}

describe('validateIdIntegrity', () => {
  it('is silent on a healthy stamped schema', () => {
    const result = validateIdIntegrity(parse(healthyJson()));
    expect(idCodes(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('is silent on a legacy id-free schema', () => {
    const v = healthyJson();
    const orbital = (v.orbitals as Record<string, unknown>[])[0];
    delete orbital.id;
    delete (orbital.entity as Record<string, unknown>).id;
    const td = (orbital.traits as Record<string, unknown>[])[0];
    delete td.id;
    delete td.linkedEntityId;
    delete (td.emits as Record<string, unknown>[])[0].eventId;
    const listen = (td.listens as Record<string, unknown>[])[0];
    delete listen.eventId;
    delete listen.triggersId;
    delete (listen.source as Record<string, unknown>).traitId;
    delete (orbital.pages as Record<string, unknown>[])[0].id;
    delete v.ledger;
    delete v.schemaVersion;

    const result = validateIdIntegrity(parse(v));
    expect(idCodes(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('fires ORB_ID_UNKNOWN_REF on a dangling id', () => {
    const v = clone(healthyJson());
    // Well-formed Entity id, absent from arena + ledger.
    const td = ((v.orbitals as Record<string, unknown>[])[0].traits as Record<string, unknown>[])[0];
    td.linkedEntityId = 'ent_GHOST00000000000000000000';
    expect(idCodes(validateIdIntegrity(parse(v)))).toEqual(['ORB_ID_UNKNOWN_REF']);
  });

  it('fires ORB_ID_NAME_MISMATCH on dual-carry drift', () => {
    const v = clone(healthyJson());
    // id still resolves in the ledger (curName REFRESH), but the name drifts.
    const td = ((v.orbitals as Record<string, unknown>[])[0].traits as Record<string, unknown>[])[0];
    (td.emits as Record<string, unknown>[])[0].event = 'RELOAD';
    expect(idCodes(validateIdIntegrity(parse(v)))).toEqual(['ORB_ID_NAME_MISMATCH']);
  });

  it('fires ORB_ID_KIND_MISMATCH on a wrong-prefix id', () => {
    const v = clone(healthyJson());
    // A Trait id in the entity `linkedEntityId` position, kept name-agreeing via
    // a ledger row so ONLY the kind rule fires.
    const td = ((v.orbitals as Record<string, unknown>[])[0].traits as Record<string, unknown>[])[0];
    td.linkedEntityId = 'trt_TASKENT00000000000000000';
    (((v.ledger as Record<string, unknown>).entries) as Record<string, unknown>)['trt_TASKENT00000000000000000'] = {
      id: 'trt_TASKENT00000000000000000',
      kind: 'trait',
      bakedName: 'Task',
      curName: 'Task',
      renames: [],
      owner: 'workspace',
    };
    expect(idCodes(validateIdIntegrity(parse(v)))).toEqual(['ORB_ID_KIND_MISMATCH']);
  });

  it('fires ORB_ID_LEDGER_ORPHAN as a non-blocking warning', () => {
    const v = clone(healthyJson());
    (((v.ledger as Record<string, unknown>).entries) as Record<string, unknown>)['ent_GHOST00000000000000000000'] = {
      id: 'ent_GHOST00000000000000000000',
      kind: 'entity',
      bakedName: 'Ghost',
      curName: 'Ghost',
      renames: [],
      owner: 'workspace',
    };
    const result = validateIdIntegrity(parse(v));
    expect(idCodes(result)).toEqual(['ORB_ID_LEDGER_ORPHAN']);
    // Orphan is a warning: it does not block validation (zero errors).
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
  });

  it('exempts an event ledger row while its parent trait lives', () => {
    const v = clone(healthyJson());
    (((v.ledger as Record<string, unknown>).entries) as Record<string, unknown>)['evt_INTERNAL00000000000000'] = {
      id: 'evt_INTERNAL00000000000000',
      kind: 'event',
      bakedName: 'TICK',
      curName: 'TICK',
      renames: [],
      owner: 'workspace',
      parent: 'trt_LIST000000000000000000000',
    };
    // Event row with no id field carrying it, but a live parent trait → not orphan.
    expect(idCodes(validateIdIntegrity(parse(v)))).toEqual([]);
  });
});
