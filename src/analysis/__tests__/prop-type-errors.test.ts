/**
 * UISlotRenderer draws a visible "expected object, got array" box when a
 * pattern prop's value has the wrong shape. Verifiers must count it as a
 * failure — 2026-09-30 std-booking-system /book shipped with three of them.
 */
import { describe, it, expect } from 'vitest';
import { PATTERN_PROP_TYPE_ERROR_TESTID } from '@almadar/core';
import { propTypeErrorMessages, PROP_TYPE_ERROR_SELECTOR } from '../dom-inspector.js';

describe('pattern prop type errors', () => {
  it('turns each rendered error box into one failure naming its pattern', () => {
    expect(propTypeErrorMessages([
      { pattern: 'form-section', message: 'form-section.initialData: expected object, got array' },
      { pattern: 'detail-panel', message: 'detail-panel.entity: expected object, got array' },
    ])).toEqual([
      'Pattern prop type error (form-section): form-section.initialData: expected object, got array',
      'Pattern prop type error (detail-panel): detail-panel.entity: expected object, got array',
    ]);
  });

  it('control: no error boxes, no failures', () => {
    expect(propTypeErrorMessages([])).toEqual([]);
  });

  it('selects the marker the renderer declares, not text', () => {
    expect(PROP_TYPE_ERROR_SELECTOR).toBe(`[data-testid="${PATTERN_PROP_TYPE_ERROR_TESTID}"]`);
  });
});
