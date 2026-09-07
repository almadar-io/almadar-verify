import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, SExpr } from '@almadar/core';
import { deriveViewerRequirement } from '../viewer-requirement.js';

/**
 * C1-V9 item A — the JS twin of `orbital-verify`'s per-step persona
 * derivation (`role_satisfying_policy`/`owner_columns_from_policy` in
 * `orbital-core`). Mirrors `std-notes.lolo`'s real shape: `Note
 * [persistent: notes]` declares `@read/@create/@update/@delete ["=",
 * (object/get @entity authorId), @user.id]` (pure ownership), and adds an
 * `Author [identity]` roster with a `role` vocabulary so the role-derived
 * half can be exercised too (`std-time-tracking`'s `Employee [identity]`
 * shape: `(or (= @user.role "approver") (= (object/get @entity id)
 * @user.id))`).
 */
function schemaWith(overrides: {
  createPolicy?: SExpr;
  updatePolicy?: SExpr;
  deletePolicy?: SExpr;
}): OrbitalSchema {
  return {
    name: 'viewer-requirement-fixture',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'NoteOrbital',
        entity: {
          name: 'Note',
          persistence: 'persistent',
          collection: 'notes',
          fields: [
            { name: 'id', type: 'string', required: true },
            { name: 'authorId', type: 'relation', relation: { entity: 'Author', cardinality: 'one' } },
          ],
          ...(overrides.createPolicy !== undefined && { create_policy: overrides.createPolicy }),
          ...(overrides.updatePolicy !== undefined && { update_policy: overrides.updatePolicy }),
          ...(overrides.deletePolicy !== undefined && { delete_policy: overrides.deletePolicy }),
        },
        auxiliaryEntities: [
          {
            name: 'Author',
            persistence: 'persistent',
            collection: 'authors',
            identity: true,
            fields: [
              { name: 'id', type: 'string', required: true },
              { name: 'role', type: 'string', values: ['member', 'admin'] },
            ],
          },
        ],
        pages: [],
        traits: [],
      },
    ],
  };
}

const OWNER_POLICY: SExpr = ['=', ['object/get', '@entity', 'authorId'], '@user.id'];
const ROLE_POLICY: SExpr = ['=', '@user.role', 'admin'];
const OR_POLICY: SExpr = ['or', ROLE_POLICY, OWNER_POLICY];

describe('deriveViewerRequirement (C1-V9 item A)', () => {
  it('undefined when the action declares no policy at all — no restriction', () => {
    const schema = schemaWith({});
    expect(deriveViewerRequirement(schema, 'Note', 'update')).toBeUndefined();
  });

  it('pure ownership policy (update/delete): owner.sourceEntity is the mutated entity itself', () => {
    const schema = schemaWith({ updatePolicy: OWNER_POLICY, deletePolicy: OWNER_POLICY });
    expect(deriveViewerRequirement(schema, 'Note', 'update')).toEqual({
      owner: { sourceEntity: 'Note', sourceField: 'authorId' },
    });
    expect(deriveViewerRequirement(schema, 'Note', 'delete')).toEqual({
      owner: { sourceEntity: 'Note', sourceField: 'authorId' },
    });
  });

  it('pure ownership policy (create): owner.sourceEntity is the IDENTITY entity, useDefaultId + payloadOwnerField set', () => {
    const schema = schemaWith({ createPolicy: OWNER_POLICY });
    expect(deriveViewerRequirement(schema, 'Note', 'create')).toEqual({
      owner: {
        sourceEntity: 'Author',
        sourceField: 'id',
        useDefaultId: true,
        payloadOwnerField: 'authorId',
      },
    });
  });

  it('pure role policy: role.field/value derived from the identity entity\'s declared vocabulary', () => {
    const schema = schemaWith({ deletePolicy: ROLE_POLICY });
    expect(deriveViewerRequirement(schema, 'Note', 'delete')).toEqual({
      role: { field: 'role', value: 'admin' },
    });
  });

  it('a combined (or role owner) policy derives BOTH — either alone would satisfy it for real, carrying both is harmless', () => {
    const schema = schemaWith({ deletePolicy: OR_POLICY });
    expect(deriveViewerRequirement(schema, 'Note', 'delete')).toEqual({
      role: { field: 'role', value: 'admin' },
      owner: { sourceEntity: 'Note', sourceField: 'authorId' },
    });
  });

  it('declared but nothing derivable (e.g. a role literal not in the identity\'s vocabulary) returns an empty requirement, distinct from undefined', () => {
    const schema = schemaWith({ updatePolicy: ['=', '@user.role', 'superuser'] });
    expect(deriveViewerRequirement(schema, 'Note', 'update')).toEqual({});
  });
});
