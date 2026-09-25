/**
 * `buildMinimalPayload` must honour the container a field's `type` declares
 * before expanding its `properties`. Lowering flattens `particles : [Fx]` to
 * `{ type: '[object]', properties: <Fx fields> }`; the walk used to read the
 * `properties` alone and synthesize ONE object, which the circuit accepted
 * and the evaluator then crashed on (`(s ?? []).map is not a function` on
 * `std-fx-particles` BURST in `ui-pirate-board-3d`).
 */
import { describe, it, expect } from 'vitest';
import { buildMinimalPayload, type PayloadFieldSpec } from '../interaction.js';

const FX_PROPERTIES: PayloadFieldSpec[] = [
  { name: 'id', type: 'string', required: true },
  { name: 'type', type: 'string', required: true },
  { name: 'x', type: 'number', required: true },
  { name: 'ttl', type: 'number', required: true },
];

describe('buildMinimalPayload — array-of-object fields', () => {
  it('synthesizes an array of element rows for [object] + properties', () => {
    const payload = buildMinimalPayload([{ name: 'particles', type: '[object]', properties: FX_PROPERTIES }]);
    const particles = payload.particles;
    expect(Array.isArray(particles)).toBe(true);
    if (!Array.isArray(particles)) return;
    expect(particles.length).toBeGreaterThan(0);
    const row = particles[0];
    expect(typeof row === 'object' && row !== null && !Array.isArray(row)).toBe(true);
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return;
    expect(typeof row.id).toBe('string');
    expect(typeof row.x).toBe('number');
    expect(typeof row.ttl).toBe('number');
  });

  it('control: object + properties still synthesizes one plain object', () => {
    const payload = buildMinimalPayload([{ name: 'data', type: 'object', properties: FX_PROPERTIES }]);
    const data = payload.data;
    expect(typeof data === 'object' && data !== null && !Array.isArray(data)).toBe(true);
  });

  it('honours an [object] field nested inside an object contract', () => {
    const payload = buildMinimalPayload([
      { name: 'batch', type: 'object', properties: [{ name: 'particles', type: '[object]', properties: FX_PROPERTIES }] },
    ]);
    const batch = payload.batch;
    expect(typeof batch === 'object' && batch !== null && !Array.isArray(batch)).toBe(true);
    const isList = (v: unknown): v is readonly unknown[] => Array.isArray(v);
    if (typeof batch !== 'object' || batch === null || isList(batch) || batch instanceof Date) return;
    expect(Array.isArray(batch['particles'])).toBe(true);
  });

  it('keeps an entity-marked [object] field an array', () => {
    const payload = buildMinimalPayload([{ name: 'rows', type: '[object]', entity: 'Fx', properties: FX_PROPERTIES }]);
    expect(Array.isArray(payload.rows)).toBe(true);
  });
});
