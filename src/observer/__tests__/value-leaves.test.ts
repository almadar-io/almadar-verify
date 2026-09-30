/**
 * JS twin of orbital-core's `value_leaves_*` tests (sexpr.rs) and the
 * event_wiring `collect_effect_produced_events` tests: identical cases, one
 * generic interpreter. The registry under test is the real
 * `@almadar/std/canonical-operators.json` (source of truth), with an injected
 * lookup so it never depends on a rebuilt std `dist`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Trait, TraitConfigValue } from '@almadar/core';
import { valueLeaves, type OperatorLookup, type ValueNode } from '../value-leaves.js';
import { configItemActionEvents } from '../event-producers.js';

interface CanonicalEntry {
  returnType: string;
  returnSemantics?: string;
}

const registryPath = createRequire(import.meta.url).resolve('@almadar/std/canonical-operators.json');
const operators: Record<string, CanonicalEntry> = JSON.parse(readFileSync(registryPath, 'utf-8')).operators;
const lookup: OperatorLookup = (op) => operators[op];

const leaves = (value: ValueNode): ValueNode[] => valueLeaves(value, lookup);
const lambda = (body: TraitConfigValue): TraitConfigValue => ['fn', 'item', body];
const list = (...events: string[]): TraitConfigValue[] => events.map((event) => ({ event }));

describe('valueLeaves — declared returnSemantics drive the walk', () => {
  it('returns the value itself for plain and undeclared values', () => {
    expect(leaves('plain')).toEqual(['plain']);
    expect(leaves(['a', 'b'])).toEqual([['a', 'b']]);
    expect(leaves({ event: 'X' })).toEqual([{ event: 'X' }]);
  });

  it('branch-union takes every branch, never the condition', () => {
    expect(leaves(['if', '@user.role', 'T', 'E'])).toEqual(['T', 'E']);
    expect(leaves(['if', '@c', 'T'])).toEqual(['T']);
    expect(leaves(['if', '@a', ['if', '@b', 'x', 'y'], 'z'])).toEqual(['x', 'y', 'z']);
    expect(leaves(['if', '@c'])).toEqual([['if', '@c']]);
  });

  it('identity kinds see through subsets and reorders, nested', () => {
    for (const op of ['array/filter', 'array/slice', 'array/sort', 'array/take', 'array/reverse', 'array/unique']) {
      expect(leaves([op, 'LIST', 1, 2]), op).toEqual(['LIST']);
    }
    expect(leaves(['array/slice', ['if', '@c', ['array/filter', 'A', lambda(true)], 'B'], 0, 3])).toEqual(['A', 'B']);
  });

  it('union-of-args covers every argument or only the listed ones', () => {
    expect(leaves(['array/concat', 'A', ['if', '@c', 'B', 'C'], 'D'])).toEqual(['A', 'B', 'C', 'D']);
    expect(leaves(['array/append', 'LIST', { event: 'X' }])).toEqual(['LIST', { event: 'X' }]);
    expect(leaves(['array/prepend', 'LIST', { event: 'X' }])).toEqual(['LIST', { event: 'X' }]);
    expect(leaves(['array/insert', 'LIST', 4, 'ELEM'])).toEqual(['LIST', 'ELEM']);
    expect(leaves(['array/append', 'LIST'])).toEqual([['array/append', 'LIST']]);
  });

  it('do yields its last argument and let its body', () => {
    expect(leaves(['do', ['set', '@x', 1], 'LAST'])).toEqual(['LAST']);
    expect(leaves(['let', [['x', 1]], ['if', '@c', 'P', 'Q']])).toEqual(['P', 'Q']);
    expect(leaves(['do'])).toEqual([['do']]);
  });

  it('lambda-result yields the lambda body leaves', () => {
    expect(
      leaves(['array/map', '@entity.items', lambda(['if', '@item.ok', { event: 'A' }, { event: 'B' }])]),
    ).toEqual([{ event: 'A' }, { event: 'B' }]);
    expect(leaves(['array/map', '@entity.items', '@config.fn'])).toEqual([['array/map', '@entity.items', '@config.fn']]);
  });

  it('paired control: an undeclared operator is opaque, even over or under a declared one', () => {
    for (const op of ['array/zip', 'array/flatten', 'array/groupBy', 'array/partition', 'array/range']) {
      const call: TraitConfigValue = [op, list('A'), list('B')];
      expect(leaves(call), op).toEqual([call]);
    }
    expect(leaves(['array/slice', ['array/zip', 'A', 'B'], 0, 2])).toEqual([['array/zip', 'A', 'B']]);
  });
});

describe('configItemActionEvents — credits events through declared value sources', () => {
  const producedThrough = (itemActions: TraitConfigValue): Set<string> => {
    const trait: Trait = {
      name: 'TaskList',
      scope: 'instance',
      config: { itemActions: { type: 'array', default: itemActions } },
    };
    return configItemActionEvents(trait, lookup);
  };
  const set = (...events: string[]): Set<string> => new Set(events);

  it('credits the wrapped list through subset/reorder operators', () => {
    for (const op of ['array/slice', 'array/sort', 'array/take', 'array/reverse', 'array/unique']) {
      expect(producedThrough([op, list('A', 'B'), 1, 2]), op).toEqual(set('A', 'B'));
    }
    expect(producedThrough(['array/filter', list('A', 'B'), lambda(true)])).toEqual(set('A', 'B'));
  });

  it('credits every concat list, and append/prepend/insert add the element descriptor', () => {
    expect(producedThrough(['array/concat', list('A'), list('B', 'C')])).toEqual(set('A', 'B', 'C'));
    expect(producedThrough(['array/append', list('A'), { event: 'EXTRA' }])).toEqual(set('A', 'EXTRA'));
    expect(producedThrough(['array/insert', list('A'), 0, { event: 'EXTRA' }])).toEqual(set('A', 'EXTRA'));
  });

  it('credits do/let results and a nested filter inside an if', () => {
    expect(producedThrough(['do', ['set', '@x', 1], list('A', 'B')])).toEqual(set('A', 'B'));
    expect(producedThrough(['if', '@r', ['array/filter', list('A', 'B'), lambda(true)], list('C')])).toEqual(
      set('A', 'B', 'C'),
    );
  });

  it('credits the lambda body of a map, not the mapped collection', () => {
    expect(producedThrough(['array/map', list('NOT_THE_COLLECTION'), lambda(list('ROW'))])).toEqual(set('ROW'));
  });

  it('paired control: undeclared operators credit nothing', () => {
    expect(producedThrough(['array/zip', list('A'), list('B')]).size).toBe(0);
    expect(producedThrough(['array/flatten', list('A')]).size).toBe(0);
    expect(producedThrough(['array/slice', ['array/zip', list('A'), list('B')], 0]).size).toBe(0);
  });
});
