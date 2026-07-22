import { describe, expect, it } from 'vitest';
import { isUiFactoryBoard } from '../ui-factory-board.js';

describe('isUiFactoryBoard', () => {
  it('recognizes the lolo-ui generator stamp', () => {
    expect(
      isUiFactoryBoard({ description: 'Typography — UI factory (1:1 with the @almadar/ui typography pattern).' }),
    ).toBe(true);
  });

  it('rejects hand-authored descriptions and missing descriptions', () => {
    expect(isUiFactoryBoard({ description: 'std-wizard — generic N-step data-collection wizard' })).toBe(false);
    expect(isUiFactoryBoard({})).toBe(false);
  });
});
