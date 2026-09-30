/**
 * A settled page must not show a loading or empty view for data its fetch
 * already returned (G-VERIFY-051). std-inventory /stock-levels sat on its
 * spinner with 6 StockLevel rows loaded; std-construction-pm /site-diary showed
 * "No events" with 6 TimelineEntry rows loaded. Neither tripped any gate.
 */
import { describe, it, expect } from 'vitest';
import { classifySettledRender } from '../settled-render.js';

const entityOf = new Map([
  ['StockLevelLedgerPanel', 'StockLevel'],
  ['InlineSpinnerRender1', 'SpinnerItem'],
  ['SiteDiaryFeed', 'TimelineEntry'],
  ['InlineStackRender8', 'StackItem'],
  ['ModerationRules', 'ModerationRule'],
]);

describe('classifySettledRender', () => {
  it('a loading view under a trait whose entity came back with rows is a finding', () => {
    const f = classifySettledRender([{ kind: 'loading', traits: ['InlineSpinnerRender1', 'StockLevelLedgerPanel'] }], entityOf, { StockLevel: 6 });
    expect(f).toEqual([{ kind: 'loading', trait: 'StockLevelLedgerPanel', entity: 'StockLevel', rows: 6 }]);
  });

  it('an empty view inside an embedded child of a loaded trait is a finding', () => {
    const f = classifySettledRender([{ kind: 'empty', traits: ['InlineStackRender8', 'SiteDiaryFeed'] }], entityOf, { TimelineEntry: 6 });
    expect(f).toEqual([{ kind: 'empty', trait: 'SiteDiaryFeed', entity: 'TimelineEntry', rows: 6 }]);
  });

  it('control: an empty view for an entity that returned no rows (policy-empty, genuinely empty) is not', () => {
    expect(classifySettledRender([{ kind: 'empty', traits: ['ModerationRules'] }], entityOf, { ModerationRule: 0 })).toEqual([]);
    expect(classifySettledRender([{ kind: 'empty', traits: ['ModerationRules'] }], entityOf, {})).toEqual([]);
  });

  it('edge: the same trait reported once however many markers it rendered', () => {
    const node = { kind: 'empty' as const, traits: ['SiteDiaryFeed'] };
    expect(classifySettledRender([node, node], entityOf, { TimelineEntry: 3 })).toHaveLength(1);
  });

  it('edge: a trait the schema does not know is skipped, not guessed', () => {
    expect(classifySettledRender([{ kind: 'loading', traits: ['Unknown'] }], entityOf, { StockLevel: 6 })).toEqual([]);
  });
});
