import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { declaredEntityRow } from '../declared-entity-row.js';

const schema: OrbitalSchema = {
  name: 'std-modal-editor-fixture',
  designTokens: {},
  customPatterns: {},
  orbitals: [
    {
      name: 'ModalEditorOrbital',
      entity: {
        name: 'ModalRecord',
        persistence: 'runtime',
        fields: [
          { name: 'a', type: 'string', default: '' },
          { name: 'b', type: 'number', default: 0 },
        ],
      },
      pages: [],
      traits: [],
    },
  ],
};

describe('declaredEntityRow', () => {
  it('seeds declared field defaults for the linked entity', () => {
    expect(declaredEntityRow(schema, 'ModalRecord')).toEqual({ a: '', b: 0 });
  });

  it('overrides win over declared defaults', () => {
    expect(declaredEntityRow(schema, 'ModalRecord', { a: 'x' })).toEqual({ a: 'x', b: 0 });
  });

  it('no linkedEntity yields overrides only', () => {
    expect(declaredEntityRow(schema, undefined, { a: 'x' })).toEqual({ a: 'x' });
  });

  it('unmatched entity name yields overrides only', () => {
    expect(declaredEntityRow(schema, 'NoSuchEntity', { a: 'x' })).toEqual({ a: 'x' });
  });
});
