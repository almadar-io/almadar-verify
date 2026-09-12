import { describe, it, expect } from 'vitest';
import { collectEntityFields, synthesizeSuccessPayload } from '../payload-synth.js';
import type { OrbitalSchema } from '@almadar/core';

describe('synthesizeSuccessPayload — nested object contracts', () => {
  it('builds `data` from its declared properties so required columns reach the persist (chat DO_CREATE shape)', () => {
    const payload = synthesizeSuccessPayload(
      [{
        name: 'data',
        type: 'object',
        properties: [
          { name: 'attachment', type: 'string' },
          { name: 'content', type: 'string', required: true },
          { name: 'channel', type: 'string', required: true },
        ],
      }],
      'ChatMessage',
      { ChatMessage: [{ name: 'id', type: 'string', required: true }, { name: 'content', type: 'string', required: true }, { name: 'channel', type: 'string', required: true }] },
    );
    const data = payload['data'];
    expect(data !== null && typeof data === 'object' && !Array.isArray(data)).toBe(true);
    const row = data as Record<string, unknown>;
    expect(typeof row['content']).toBe('string');
    expect((row['content'] as string).length).toBeGreaterThan(0);
    expect(typeof row['channel']).toBe('string');
    expect((row['channel'] as string).length).toBeGreaterThan(0);
  });

  it('leaves an entity-typed field to the row expansion, not the nested builder', () => {
    const payload = synthesizeSuccessPayload(
      [{ name: 'data', type: 'object', entity: 'ChatMessage', properties: [{ name: 'id', type: 'string', required: true }] }],
      'ChatMessage',
      { ChatMessage: [{ name: 'id', type: 'string', required: true }, { name: 'content', type: 'string', required: true }] },
    );
    expect(payload['data']).toBeDefined();
  });
});

describe('collectEntityFields — auxiliary entities are first-class', () => {
  it('collects the auxiliary record entity behind an identity primary (modal/good shape)', () => {
    const schema: OrbitalSchema = {
      name: 'efficacy-modal',
      version: '1.0.0',
      orbitals: [{
        name: 'ModalRecordOrbital',
        entity: { name: 'Editor', fields: [{ name: 'id', type: 'string', required: true }, { name: 'role', type: 'string' }] },
        auxiliaryEntities: [{ name: 'ModalRecord', fields: [{ name: 'id', type: 'string', required: true }, { name: 'name', type: 'string', required: true }] }],
        pages: [],
        traits: [],
      }],
    };
    const fields = collectEntityFields(schema);
    expect(Object.keys(fields).sort()).toEqual(['Editor', 'ModalRecord']);
    expect(fields['ModalRecord'].map((f) => f.name)).toEqual(['id', 'name']);
  });
});

describe('synthesizeSuccessPayload — entity-typed fields expand from their own entity', () => {
  it('builds `data : ModalRecord!` from ModalRecord, not the trait\'s linked entity', () => {
    const payload = synthesizeSuccessPayload(
      [{ name: 'data', type: 'object', entity: 'ModalRecord', required: true, properties: [{ name: 'id', type: 'string', required: true }, { name: 'name', type: 'string', required: true }] }],
      'Editor',
      {
        Editor: [{ name: 'id', type: 'string', required: true }, { name: 'role', type: 'string' }],
        ModalRecord: [{ name: 'id', type: 'string', required: true }, { name: 'name', type: 'string', required: true }, { name: 'status', type: 'string' }],
      },
    );
    const data = payload['data'] as Record<string, unknown>;
    expect(typeof data['name']).toBe('string');
    expect((data['name'] as string).length).toBeGreaterThan(0);
    expect(data['role']).toBeUndefined();
  });
});

