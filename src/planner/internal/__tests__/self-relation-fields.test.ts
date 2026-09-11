import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { crossEntityRestrictRelations, pickTargetRow, selfRelationFieldNames } from '../self-relation-fields.js';

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

/**
 * C1-V17 — mirrors std-realtime-chat's real shape: `Channel` has NO
 * self-relation at all, but `ChannelMember.channel` AND `ChatMessage.channel`
 * both restrict-relate to it. `selfRelationFieldNames` alone (the pre-fix
 * scan) reports empty for `Channel` — the planner had no way to know a
 * `Channel` delete could ever be blocked, let alone by which entities.
 */
function channelSchema(): OrbitalSchema {
  return {
    name: 'cross-entity-restrict-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'ChannelOrbital',
        entity: { name: 'Channel', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] },
        auxiliaryEntities: [
          {
            name: 'ChannelMember',
            persistence: 'persistent',
            fields: [
              { name: 'id', type: 'string', required: true },
              { name: 'channel', type: 'relation', relation: { entity: 'Channel', cardinality: 'one' } },
            ],
          },
          {
            name: 'ChatMessage',
            persistence: 'persistent',
            fields: [
              { name: 'id', type: 'string', required: true },
              { name: 'channel', type: 'relation', relation: { entity: 'Channel', cardinality: 'one' } },
            ],
          },
        ],
        pages: [],
        traits: [],
      },
    ],
  };
}

describe('crossEntityRestrictRelations (C1-V17)', () => {
  it('finds every OTHER entity whose relation field restrict-targets the entity, self excluded', () => {
    const rels = crossEntityRestrictRelations(channelSchema(), 'Channel');
    expect(rels).toEqual(
      expect.arrayContaining([
        { entityName: 'ChannelMember', fieldName: 'channel' },
        { entityName: 'ChatMessage', fieldName: 'channel' },
      ]),
    );
    expect(rels).toHaveLength(2);
  });

  it('empty when no relation field anywhere in the schema targets the entity', () => {
    expect(crossEntityRestrictRelations(channelSchema(), 'ChannelMember')).toEqual([]);
  });

  it('never confuses a self-relation for a cross-entity one', () => {
    // Note.parentId : Note is a SELF relation — selfRelationFieldNames'
    // job, not crossEntityRestrictRelations'.
    expect(crossEntityRestrictRelations(noteSchema(), 'Note')).toEqual([]);
  });
});

describe('pickTargetRow (C1-V12: server-truth vs browser-visible subset)', () => {
  it('serverRows === visibleRows: picks the first row unreferenced by self-relation', () => {
    const rows = [
      { id: 'root', parentId: '' },
      { id: 'child-1', parentId: 'root' },
      { id: 'child-2', parentId: 'root' },
    ];
    expect(pickTargetRow(rows, rows, ['parentId'])).toEqual({ row: rows[1] });
    expect(pickTargetRow(rows, rows, undefined)).toEqual({ row: rows[0] });
  });

  it('falls back to the first row when every row is self-referenced (last resort, no worse than before)', () => {
    const rows = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ];
    expect(pickTargetRow(rows, rows, ['parentId'])).toEqual({ row: rows[0] });
  });

  it('C1-V10 item 2: finds the genuine leaf in a 3-generation chain (grandchild → child → root), regardless of array order', () => {
    const rows = [
      { id: 'grandchild', parentId: 'child' },
      { id: 'child', parentId: 'root' },
      { id: 'root', parentId: '' },
    ];
    expect(pickTargetRow(rows, rows, ['parentId'])).toEqual({ row: rows[0] });
  });

  it('C1-V10 item 2: avoids a row referenced via an ARRAY-valued self-relation (many-cardinality), not just a scalar field', () => {
    const rows = [
      { id: 'root', relatedIds: [] },
      { id: 'child', relatedIds: ['root'] },
    ];
    expect(pickTargetRow(rows, rows, ['relatedIds'])).toEqual({ row: rows[1] });
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

  it('requireVisible: true fails closed with a reason+code when the intersection is empty (every visible row is referenced server-side)', () => {
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
      code: 'all-referenced',
      reason: expect.stringContaining('every candidate row is referenced'),
    });
  });

  it('requireVisible: true fails closed with a no-rows code when NO rows of the entity are visible at all', () => {
    const serverRows = [{ id: 'a' }, { id: 'b' }];
    const result = pickTargetRow(serverRows, [], undefined, { requireVisible: true });
    expect(result).toEqual({
      code: 'no-rows',
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

  describe('crossEntity (C1-V17: a restrict relation on a DIFFERENT entity)', () => {
    it('finds the row NOT referenced by any other entity\'s restrict relation, with no self-relation involved at all', () => {
      const c1 = { id: 'c1' };
      const c2 = { id: 'c2' };
      const channels = [c1, c2];
      const channelMembers = [{ id: 'm1', channel: 'c1' }];

      const result = pickTargetRow(channels, channels, undefined, {
        requireUnreferenced: true,
        crossEntity: [{ field: 'channel', rows: channelMembers }],
      });
      expect(result).toEqual({ row: c2 });
    });

    it('never falls back to row 0 as "safe" when it is referenced by another entity — the pre-fix blind spot', () => {
      // std-realtime-chat shape: Channel has no self-relation, but BOTH
      // ChannelMember.channel and ChatMessage.channel restrict-reference
      // it. Row 0 ('c1') IS referenced (by a ChannelMember row) — the old
      // self-relation-only check would never have known that and would
      // have handed back row 0 as if it were safe.
      const c1 = { id: 'c1' };
      const c2 = { id: 'c2' };
      const channels = [c1, c2];
      const channelMembers = [{ id: 'm1', channel: 'c1' }];
      const chatMessages = [{ id: 'msg1', channel: 'c2' }];

      const result = pickTargetRow(channels, channels, undefined, {
        requireUnreferenced: true,
        crossEntity: [
          { field: 'channel', rows: channelMembers },
          { field: 'channel', rows: chatMessages },
        ],
      });
      // Both c1 and c2 are referenced (by a different entity each) —
      // every candidate is blocked, so this must fail closed with
      // 'all-referenced', never silently return c1 (or any row).
      expect(result).toEqual({
        code: 'all-referenced',
        reason: expect.stringContaining('every candidate row is referenced'),
      });
    });
  });
});
