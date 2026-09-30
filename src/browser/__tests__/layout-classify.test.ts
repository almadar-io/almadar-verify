import { describe, it, expect } from 'vitest';
import { classifyLayout, type MeasuredBox } from '../layout.js';

const VW = 375;

function box(parent: number, left: number, right: number, extra: Partial<MeasuredBox> = {}): MeasuredBox {
  return {
    parent,
    left,
    right,
    width: right - left,
    height: 20,
    clipsX: false,
    overflowX: 'visible',
    scrollOverflowX: 0,
    fixed: false,
    hidden: false,
    pattern: null,
    patternPath: null,
    trait: null,
    tag: 'div',
    testId: null,
    className: '',
    ...extra,
  };
}

const contents = (parent: number, pattern: string, trait: string | null = null): MeasuredBox =>
  ({ ...box(parent, 0, 0, { pattern, patternPath: `root.${pattern}`, trait }), height: 0 });

function classify(boxes: MeasuredBox[], scrollWidth = VW) {
  return classifyLayout({ viewport: { width: VW, height: 800 }, documentScrollWidth: scrollWidth, boxes });
}

describe('classifyLayout — what counts as a responsive break', () => {
  it('reports nothing when every box fits the viewport', () => {
    const r = classify([box(-1, 0, VW), box(0, 16, VW - 16)]);
    expect(r.offenders).toEqual([]);
    expect(r.documentOverflowPx).toBe(0);
  });

  it('attributes a box sticking out to the pattern wrapper it renders inside', () => {
    const r = classify([box(-1, 0, VW), contents(0, 'data-grid'), box(1, 0, 900)], 900);
    expect(r.offenders).toHaveLength(1);
    expect(r.offenders[0]).toMatchObject({ pattern: 'data-grid', overflowRightPx: 525, widthPx: 900 });
    expect(r.documentOverflowPx).toBe(525);
  });

  it('treats content inside a fitting scroll container as contained', () => {
    const r = classify([box(-1, 0, VW, { clipsX: true }), box(0, 0, 900)]);
    expect(r.offenders).toEqual([]);
  });

  it('does not excuse content whose clipping ancestor itself overflows', () => {
    const r = classify([box(-1, 0, VW), box(0, 0, 600, { clipsX: true }), box(1, 0, 900)]);
    expect(r.offenders).toHaveLength(1);
    expect(r.offenders[0].widthPx).toBe(600);
  });

  it('skips a fixed drawer parked fully off-screen', () => {
    const r = classify([box(-1, 0, VW), box(0, VW, VW + 300, { fixed: true }), box(1, VW + 10, VW + 290)]);
    expect(r.offenders).toEqual([]);
  });

  it('reports a fixed modal wider than the viewport', () => {
    const r = classify([box(-1, 0, VW), box(0, 20, 520, { fixed: true })]);
    expect(r.offenders).toHaveLength(1);
    expect(r.offenders[0].overflowRightPx).toBe(145);
  });

  it('reports only the outermost offender and names the deepest overflowing pattern', () => {
    const r = classify([
      box(-1, 0, VW),
      contents(0, 'stack'),
      box(1, 0, 700),
      contents(2, 'form-field'),
      box(3, 0, 700),
      contents(4, 'input'),
      box(5, 0, 690),
    ]);
    expect(r.offenders).toHaveLength(1);
    expect(r.offenders[0]).toMatchObject({ pattern: 'stack', deepestPattern: 'input' });
  });

  it('reports left-edge overflow', () => {
    const r = classify([box(-1, 0, VW), box(0, -40, 200)]);
    expect(r.offenders[0]).toMatchObject({ overflowLeftPx: 40, overflowRightPx: 0 });
  });

  it('ignores hidden, zero-size and 1px sr-only boxes', () => {
    const r = classify([
      box(-1, 0, VW),
      box(0, 0, 900, { hidden: true }),
      contents(0, 'x'),
      { ...box(0, -10000, -9999), height: 1 },
    ]);
    expect(r.offenders).toEqual([]);
  });

  it('lists a clipping container whose content is wider than it, with its mode', () => {
    const r = classify([
      box(-1, 0, VW),
      contents(0, 'data-table', 'OrderBrowse'),
      box(1, 0, VW, { clipsX: true, overflowX: 'auto', scrollOverflowX: 525, className: 'overflow-x-auto' }),
      box(2, 0, 900),
    ]);
    expect(r.offenders).toEqual([]);
    expect(r.scrollers).toEqual([
      {
        pattern: 'data-table',
        patternPath: 'root.data-table',
        trait: 'OrderBrowse',
        tag: 'div',
        testId: null,
        className: 'overflow-x-auto',
        overflowX: 'auto',
        widthPx: VW,
        hiddenContentPx: 525,
      },
    ]);
  });

  it('does not list a clipping container whose content fits', () => {
    const r = classify([box(-1, 0, VW, { clipsX: true, overflowX: 'auto', scrollOverflowX: 0 })]);
    expect(r.scrollers).toEqual([]);
  });

  it('keeps sibling offenders separate', () => {
    const r = classify([box(-1, 0, VW), box(0, 0, 500, { tag: 'table' }), box(0, 0, 450, { tag: 'nav' })]);
    expect(r.offenders.map((o) => o.tag)).toEqual(['table', 'nav']);
  });
});

describe('classifyLayout — squished patterns (declared minUsableWidth, G-VERIFY-050)', () => {
  const minWidths = new Map([['search-input', 160], ['data-list', 200]]);
  const withMin = (boxes: MeasuredBox[]) =>
    classifyLayout({ viewport: { width: VW, height: 800 }, documentScrollWidth: VW, boxes }, minWidths);

  it('reports a pattern whose rendered root is narrower than its declared minimum', () => {
    const r = withMin([box(-1, 0, VW), contents(0, 'search-input', 'RouteSearch'), box(1, 16, 106)]);
    expect(r.squished).toEqual([
      { pattern: 'search-input', patternPath: 'root.search-input', trait: 'RouteSearch', widthPx: 90, minWidthPx: 160 },
    ]);
  });

  it('control: a pattern at or above its minimum is fine', () => {
    const r = withMin([box(-1, 0, VW), contents(0, 'search-input'), box(1, 16, 176)]);
    expect(r.squished).toEqual([]);
  });

  it('edge: a pattern with no declared minimum is never squished', () => {
    const r = withMin([box(-1, 0, VW), contents(0, 'stack'), box(1, 0, 20)]);
    expect(r.squished).toEqual([]);
  });

  it('edge: a hidden or zero-size root is not measured', () => {
    const r = withMin([box(-1, 0, VW), contents(0, 'data-list'), box(1, 0, 37, { hidden: true })]);
    expect(r.squished).toEqual([]);
  });

  it('edge: without a min-width table, nothing is squished', () => {
    const r = classify([box(-1, 0, VW), contents(0, 'search-input'), box(1, 16, 106)]);
    expect(r.squished).toEqual([]);
  });
});
