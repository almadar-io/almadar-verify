import { describe, it, expect } from 'vitest';
import { frameScreenshotFileName } from '../frame-screenshot-name.js';
import type { ExtendedWalkStep } from '../../../planner/types.js';

function step(over: Partial<ExtendedWalkStep>): ExtendedWalkStep {
  const base: ExtendedWalkStep = { from: 'idle', to: 'listing', event: 'INIT', guardCase: null, payload: {}, isRepositioning: false, triggerKind: 'bus', coverageKey: 'k', traitName: 'T' };
  return { ...base, ...over };
}

describe('frameScreenshotFileName', () => {
  it('suffixes the testKind variant', () => {
    expect(frameScreenshotFileName('T', step({ testKind: 'crud-edit' }))).toContain('crud');
  });
  it('control: distinct variants never collide', () => {
    const a = frameScreenshotFileName('T', step({ testKind: 'crud-edit' }));
    const b = frameScreenshotFileName('T', step({ payloadCase: 'malformed' }));
    const c = frameScreenshotFileName('T', step({}));
    expect(new Set([a, b, c]).size).toBe(3);
    expect(c.endsWith('.png')).toBe(true);
  });
});
