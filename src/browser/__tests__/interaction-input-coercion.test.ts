import { describe, it, expect } from 'vitest';
import { coerceValueForInputType, generateFieldValue } from '../interaction.js';

const ISO = '2026-08-31T06:59:31.396Z';

describe('coerceValueForInputType — the string a native control accepts', () => {
  it('trims a full ISO timestamp to YYYY-MM-DD for a date input', () => {
    expect(coerceValueForInputType(ISO, 'date', 'hireDate')).toBe('2026-08-31');
  });

  it('is idempotent on a value already in the control format', () => {
    expect(coerceValueForInputType('2026-08-31', 'date', 'hireDate')).toBe('2026-08-31');
  });

  it('trims to the minute for datetime-local, month and time inputs', () => {
    expect(coerceValueForInputType(ISO, 'datetime-local', 'at')).toBe('2026-08-31T06:59');
    expect(coerceValueForInputType(ISO, 'month', 'period')).toBe('2026-08');
    expect(coerceValueForInputType(ISO, 'time', 'startsAt')).toBe('06:59');
  });

  it('re-synthesizes in-type when the value is not a date', () => {
    const out = coerceValueForInputType('basalt meadow', 'date', 'hireDate');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('re-synthesizes a numeric value for number and range inputs', () => {
    expect(Number.isFinite(Number(coerceValueForInputType('basalt meadow', 'number', 'rate')))).toBe(true);
    expect(coerceValueForInputType('12.5', 'number', 'rate')).toBe('12.5');
    expect(Number.isFinite(Number(coerceValueForInputType('', 'range', 'level')))).toBe(true);
  });

  it('leaves text-like controls untouched', () => {
    expect(coerceValueForInputType('fjord brook', 'text', 'name')).toBe('fjord brook');
    expect(coerceValueForInputType('fjord brook', null, 'notes')).toBe('fjord brook');
  });

  it('generateFieldValue produces control-shaped values for the whole date family', () => {
    expect(generateFieldValue('date', 'd')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(generateFieldValue('datetime-local', 'd')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(generateFieldValue('month', 'd')).toMatch(/^\d{4}-\d{2}$/);
    expect(generateFieldValue('time', 'd')).toMatch(/^\d{2}:\d{2}$/);
  });
});
