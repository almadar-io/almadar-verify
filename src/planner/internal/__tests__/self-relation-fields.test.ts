import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { pickBindableRow, pickTargetRow, selfRelationFieldNames } from '../self-relation-fields.js';

/** Mirrors `std-notes.lolo`'s `Note.parentId : Note` self-relation and the
 *  record-detail generic's rewritten `Employee.seedRow : Employee` shape
 *  (both documented in `ownerFieldsFromSchema`'s doc). */
function noteSchema(): OrbitalSchema {
  return {
    name: 'self-relation-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'NoteOrbital',
        entity: {
          name: 'Note',
          persistence: 'persistent',
          fields: [
            { name: 'id', type: 'string', required: true },
            { name: 'parentId', type: 'relation', relation: { entity: 'Note', cardinality: 'one' } },
            { name: 'authorId', type: 'relation', relation: { entity: 'Author', cardinality: 'one' } },
          ],
        },
        auxiliaryEntities: [
          { name: 'Author', persistence: 'persistent', identity: true, fields: [{ name: 'id', type: 'string', required: true }] },
        ],
        pages: [],
        traits: [],
      },
    ],
  };
}

describe('selfRelationFieldNames', () => {
  it('finds a field whose relation target is the SAME entity', () => {
    expect(selfRelationFieldNames(noteSchema(), 'Note')).toEqual(['parentId']);
  });

  it('does not include a relation field pointing at a DIFFERENT entity', () => {
    expect(selfRelationFieldNames(noteSchema(), 'Note')).not.toContain('authorId');
  });

  it('empty for an entity with no self-relation', () => {
    expect(selfRelationFieldNames(noteSchema(), 'Author')).toEqual([]);
  });

  it('includes a field with no declared onDelete (defaults to restrict, mirrors the runtime)', () => {
    // noteSchema()'s parentId declares no onDelete at all — confirms the
    // default-to-restrict behavior, not just the explicit-restrict case.
    expect(selfRelationFieldNames(noteSchema(), 'Note')).toEqual(['parentId']);
  });

  it('C1-V10 item 2: excludes a self-relation field whose onDelete is cascade or nullify — those never block a delete', () => {
    const schema: OrbitalSchema = {
      name: 'self-relation-onDelete-fixture',
      designTokens: {},
      customPatterns: {},
      orbitals: [
        {
          name: 'NoteOrbital',
          entity: {
            name: 'Note',
            persistence: 'persistent',
            fields: [
              { name: 'id', type: 'string', required: true },
              { name: 'parentId', type: 'relation', relation: { entity: 'Note', cardinality: 'one', onDelete: 'restrict' } },
              { name: 'mergedIntoId', type: 'relation', relation: { entity: 'Note', cardinality: 'one', onDelete: 'cascade' } },
              { name: 'duplicateOfId', type: 'relation', relation: { entity: 'Note', cardinality: 'one', onDelete: 'nullify' } },
            ],
          },
          pages: [],
          traits: [],
        },
      ],
    };
    expect(selfRelationFieldNames(schema, 'Note')).toEqual(['parentId']);
  });
});

describe('pickBindableRow', () => {
  it('returns the first row unchanged when avoidReferencedVia is undefined/empty (existing default)', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    expect(pickBindableRow(rows, undefined)).toBe(rows[0]);
    expect(pickBindableRow(rows, [])).toBe(rows[0]);
  });

  it('skips a row referenced by another row\'s self-relation field — the mock seeder\'s tree shape (row 0 is a root with children)', () => {
    const rows = [
      { id: 'root', parentId: '' },
      { id: 'child-1', parentId: 'root' },
      { id: 'child-2', parentId: 'root' },
    ];
    expect(pickBindableRow(rows, ['parentId'])?.id).toBe('child-1');
  });

  it('falls back to the first row when every row is referenced (last resort, no worse than before)', () => {
    // A cycle — pathological, but the fallback must still return something.
    const rows = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ];
    expect(pickBindableRow(rows, ['parentId'])?.id).toBe('a');
  });

  it('undefined for an empty row set', () => {
    expect(pickBindableRow([], ['parentId'])).toBeUndefined();
  });

  it('C1-V10 item 2: finds the genuine leaf in a 3-generation chain (grandchild → child → root), regardless of array order', () => {
    // The mid-tree row ('child') has a child of its OWN ('grandchild') —
    // a row that has zero DIRECT children but SOME ancestor with children
    // is still a false positive if the reader only looks one hop up; the
    // correct answer is the row with no reference to it at ANY distance,
    // which for a tree reduces to "no direct children" at every level.
    const rows = [
      { id: 'grandchild', parentId: 'child' },
      { id: 'child', parentId: 'root' },
      { id: 'root', parentId: '' },
    ];
    expect(pickBindableRow(rows, ['parentId'])?.id).toBe('grandchild');
  });

  it('C1-V10 item 2: avoids a row referenced via an ARRAY-valued self-relation (many-cardinality), not just a scalar field', () => {
    // `relatedIds : [Note]` — a many-cardinality self-relation stores an
    // array of ids, mirroring `OrbitalServerRuntime.enforceOnDeleteRules`'s
    // own `Array.isArray(fkValue) ? fkValue.includes(id) : ...` reader. A
    // scalar-only reader would silently miss this and offer 'root' as
    // "safe" even though 'child' still restrict-blocks it.
    const rows = [
      { id: 'root', relatedIds: [] },
      { id: 'child', relatedIds: ['root'] },
    ];
    expect(pickBindableRow(rows, ['relatedIds'])?.id).toBe('child');
  });

  it('C1-V10 item 2: unions a scalar field and an array-valued field together', () => {
    const rows = [
      { id: 'root', parentId: '', relatedIds: [] },
      { id: 'child', parentId: 'root', relatedIds: [] },
      { id: 'leaf', parentId: 'child', relatedIds: [] },
    ];
    // 'root' is referenced via parentId (child.parentId), 'child' is
    // referenced via parentId (leaf.parentId) — only 'leaf' is unreferenced.
    expect(pickBindableRow(rows, ['parentId', 'relatedIds'])?.id).toBe('leaf');
  });
});

describe('pickTargetRow (C1-V12: server-truth vs browser-visible subset)', () => {
  it('serverRows === visibleRows reproduces pickBindableRow exactly (no driver.listEntityRows)', () => {
    const rows = [
      { id: 'root', parentId: '' },
      { id: 'child-1', parentId: 'root' },
      { id: 'child-2', parentId: 'root' },
    ];
    expect(pickTargetRow(rows, rows, ['parentId'])).toEqual({ row: rows[1] });
    expect(pickTargetRow(rows, rows, undefined)).toEqual({ row: rows[0] });
  });

  it('avoids a row a HIDDEN sibling references, even though that sibling never appeared in the visible/browser snapshot', () => {
    // Mirrors the reported std-notes bug: 5 of 6 rows visible, the child
    // referencing the 6th visible candidate wasn't among them. Here:
    // root/child-1/child-2 are visible; `hidden-child` (referencing
    // child-1) exists only in the server-truth set. The OLD picker
    // (computed over the visible set alone) would see child-1 as
    // unreferenced and pick it — wrong, since hidden-child's parentId
    // still trips the runtime's onDelete: restrict rule.
    const root = { id: 'root', parentId: '' };
    const child1 = { id: 'child-1', parentId: 'root' };
    const child2 = { id: 'child-2', parentId: 'root' };
    const hiddenChild = { id: 'hidden-child', parentId: 'child-1' };
    const serverRows = [root, child1, child2, hiddenChild];
    const visibleRows = [root, child1, child2];

    const result = pickTargetRow(serverRows, visibleRows, ['parentId'], {
      requireUnreferenced: true,
      requireVisible: true,
    });
    expect(result).toEqual({ row: child2 });
  });

  it('requireVisible: true fails closed with a reason when the intersection is empty (every visible row is referenced server-side)', () => {
    const root = { id: 'root', parentId: '' };
    const child1 = { id: 'child-1', parentId: 'root' };
    const hiddenChild = { id: 'hidden-child', parentId: 'child-1' };
    const serverRows = [root, child1, hiddenChild];
    const visibleRows = [root, child1]; // both referenced once hiddenChild is counted

    const result = pickTargetRow(serverRows, visibleRows, ['parentId'], {
      requireUnreferenced: true,
      requireVisible: true,
    });
    expect(result).toEqual({
      reason: expect.stringContaining('every candidate row is referenced'),
    });
  });

  it('requireVisible: true fails closed with a reason when NO rows of the entity are visible at all', () => {
    const serverRows = [{ id: 'a' }, { id: 'b' }];
    const result = pickTargetRow(serverRows, [], undefined, { requireVisible: true });
    expect(result).toEqual({
      reason: expect.stringContaining('no row is rendered on the current page'),
    });
  });

  it('requireVisible unset (bindRowFrom/bus dispatch): binds from the SERVER set when nothing is visible on the page', () => {
    // The "no row key" gap: entitiesBefore had zero rows for the entity on
    // this page, but the server's full store has one — the bus dispatch
    // needs no rendered affordance, so it should still resolve a real row.
    const serverRows = [{ id: 'note-1' }];
    const result = pickTargetRow(serverRows, [], undefined);
    expect(result).toEqual({ row: serverRows[0] });
  });
});
