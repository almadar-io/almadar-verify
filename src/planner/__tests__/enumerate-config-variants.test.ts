import { describe, it, expect } from 'vitest';
import type { DeclaredTraitConfig } from '@almadar/core';
import { enumerateConfigVariants } from '../enumerate-config-variants.js';

const CONFIG: DeclaredTraitConfig = {
  format: { type: 'string', default: 'hearts', values: ['hearts', 'bar', 'numeric'] },
  animated: { type: 'boolean', default: true },
  current: { type: 'number', default: 0 },
  className: { type: 'string', default: '' }, // free string — not swept
};

describe('enumerateConfigVariants', () => {
  const variants = enumerateConfigVariants(CONFIG);

  it('walks enum members except the default', () => {
    const formatVals = variants.filter((v) => v.field === 'format').map((v) => v.config.format);
    expect(formatVals).toEqual(expect.arrayContaining(['bar', 'numeric']));
    expect(formatVals).not.toContain('hearts'); // default skipped
  });

  it('flips a boolean to its non-default value', () => {
    const animated = variants.filter((v) => v.field === 'animated').map((v) => v.config.animated);
    expect(animated).toEqual([false]); // default true → only false varies
  });

  it('samples representative numbers (skipping the default)', () => {
    const nums = variants.filter((v) => v.field === 'current').map((v) => v.config.current);
    expect(nums).toEqual(expect.arrayContaining([25, 50, 100]));
    expect(nums).not.toContain(0); // default skipped
  });

  it('does not sweep free (non-enum) strings', () => {
    expect(variants.some((v) => v.field === 'className')).toBe(false);
  });

  it('varies one axis at a time, carrying the other fields\' defaults', () => {
    const barVariant = variants.find((v) => v.field === 'format' && v.config.format === 'bar');
    expect(barVariant?.config).toEqual({ format: 'bar', animated: true, current: 0, className: '' });
    expect(barVariant?.label).toBe('format = bar');
  });
});
