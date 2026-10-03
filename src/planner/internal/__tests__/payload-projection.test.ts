/**
 * A payload field typed `T.f` (`projectedFrom`) is dispatched with `f` of a seeded `T` row,
 * never the planner's invented value. Twin of orbital-verify
 * `tests/projected_payload_synthesis.rs`; std-notes' tag overlay filtered by a tag id the walk
 * could only invent (G-CROSS-042).
 */
import { describe, it, expect } from 'vitest';
import type { EntityRow, PayloadField } from '@almadar/core';
import { applyProjectedPayload, projectedPayloadFields } from '../payload-synth.js';

const schema: PayloadField[] = [
  { name: 'tagId', type: 'string', required: true, projectedFrom: { type: 'Tag', field: 'id' } },
  { name: 'tagName', type: 'string', projectedFrom: { type: 'Tag', field: 'name' } },
  { name: 'tagIds', type: '[string]', projectedFrom: { type: 'Tag', field: 'id' } },
  { name: 'plain', type: 'string', required: true },
];

const tags: EntityRow[] = [
  { id: 'Tag Id 1', name: 'urgent' },
  { id: 'Tag Id 2', name: 'later' },
];

const rowsFor = async (entity: string): Promise<ReadonlyArray<EntityRow>> => (entity === 'Tag' ? tags : []);

describe('projected payload fields', () => {
  it('lists each projected field with its source and whether it is an array', () => {
    expect(projectedPayloadFields(schema)).toEqual([
      { name: 'tagId', from: { type: 'Tag', field: 'id' }, array: false },
      { name: 'tagName', from: { type: 'Tag', field: 'name' }, array: false },
      { name: 'tagIds', from: { type: 'Tag', field: 'id' }, array: true },
    ]);
  });

  it('a projected id takes the first seeded row\'s id; an array wraps it', async () => {
    const payload = await applyProjectedPayload({ tagId: 'invented', tagIds: [], plain: 'x' }, projectedPayloadFields(schema), rowsFor);
    expect(payload.tagId).toBe('Tag Id 1');
    expect(payload.tagIds).toEqual(['Tag Id 1']);
  });

  it('a projection of another field takes that column of the seeded row', async () => {
    const payload = await applyProjectedPayload({}, projectedPayloadFields(schema), rowsFor);
    expect(payload.tagName).toBe('urgent');
  });

  it('control: an unprojected field keeps its synthesized value', async () => {
    const payload = await applyProjectedPayload({ plain: 'x' }, projectedPayloadFields(schema), rowsFor);
    expect(payload.plain).toBe('x');
  });

  it('edge: a target with no seeded rows leaves the synthesized value', async () => {
    const payload = await applyProjectedPayload({ tagId: 'invented' }, projectedPayloadFields(schema), async () => []);
    expect(payload.tagId).toBe('invented');
  });

  it('edge: no payload schema has no projected fields', () => {
    expect(projectedPayloadFields(undefined)).toEqual([]);
  });
});
