/**
 * Responsive-layout check: which rendered patterns overflow the viewport
 * horizontally.
 *
 * The in-page collector measures every element once; the classifier is pure
 * so the containment rules are unit-testable without a browser. Content
 * inside a clipping/scrolling ancestor that itself fits the viewport is
 * contained (an `overflow-x:auto` table wrapper is a valid responsive
 * pattern), and fixed-position content fully off-screen is an intentionally
 * hidden drawer, not a break.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import { getPatternMinUsableWidths } from '@almadar/core/patterns';
import type { LayoutOffender, LayoutReport, LayoutScroller, LayoutSquish } from '../util/types.js';

export interface MeasuredBox {
  parent: number;
  left: number;
  right: number;
  width: number;
  height: number;
  clipsX: boolean;
  overflowX: string;
  scrollOverflowX: number;
  fixed: boolean;
  hidden: boolean;
  pattern: string | null;
  patternPath: string | null;
  trait: string | null;
  tag: string;
  testId: string | null;
  className: string;
}

export interface LayoutMeasurement {
  viewport: { width: number; height: number };
  documentScrollWidth: number;
  boxes: MeasuredBox[];
}

const TOLERANCE_PX = 1;

function nearestPatternBox(boxes: MeasuredBox[], i: number): MeasuredBox | null {
  for (let j = i; j >= 0; j = boxes[j].parent) {
    if (boxes[j].pattern) return boxes[j];
  }
  return null;
}

function attribution(boxes: MeasuredBox[], i: number) {
  const p = nearestPatternBox(boxes, i);
  return {
    pattern: p?.pattern ?? null,
    patternPath: p?.patternPath ?? null,
    trait: p?.trait ?? null,
    tag: boxes[i].tag,
    testId: boxes[i].testId,
    className: boxes[i].className,
  };
}

export function classifyLayout(
  m: LayoutMeasurement,
  minWidths: ReadonlyMap<string, number> = new Map(),
): LayoutReport {
  const vw = m.viewport.width;
  const { boxes } = m;

  const sticksOut = (b: MeasuredBox): boolean =>
    b.right > vw + TOLERANCE_PX || b.left < -TOLERANCE_PX;
  const measurable = (b: MeasuredBox): boolean =>
    !b.hidden && b.width > TOLERANCE_PX && b.height > TOLERANCE_PX;

  const offending = boxes.map((b, i) => {
    if (!measurable(b) || !sticksOut(b)) return false;
    let underFixed = false;
    for (let j = i; j >= 0; j = boxes[j].parent) {
      const a = boxes[j];
      if (a.fixed) underFixed = true;
      if (j !== i && a.clipsX && measurable(a) && !sticksOut(a)) return false;
    }
    if (underFixed && (b.left >= vw || b.right <= 0)) return false;
    return true;
  });

  const offenders: LayoutOffender[] = [];
  boxes.forEach((b, i) => {
    if (!offending[i]) return;
    for (let j = b.parent; j >= 0; j = boxes[j].parent) {
      if (offending[j]) return;
    }
    let deepest = i;
    let deepestDepth = 0;
    boxes.forEach((_, k) => {
      if (!offending[k] || k === i) return;
      let depth = 0;
      for (let j = boxes[k].parent; j >= 0; j = boxes[j].parent) {
        depth++;
        if (j === i) {
          if (depth > deepestDepth) {
            deepest = k;
            deepestDepth = depth;
          }
          return;
        }
      }
    });
    offenders.push({
      ...attribution(boxes, i),
      deepestPattern: nearestPatternBox(boxes, deepest)?.pattern ?? null,
      widthPx: Math.round(b.width),
      overflowRightPx: Math.max(0, Math.round(b.right - vw)),
      overflowLeftPx: Math.max(0, Math.round(-b.left)),
    });
  });

  const scrollers: LayoutScroller[] = [];
  boxes.forEach((b, i) => {
    if (!b.clipsX || !measurable(b) || b.scrollOverflowX <= TOLERANCE_PX) return;
    scrollers.push({
      ...attribution(boxes, i),
      overflowX: b.overflowX,
      widthPx: Math.round(b.width),
      hiddenContentPx: Math.round(b.scrollOverflowX),
    });
  });

  // A pattern wrapper is `display: contents`; its first child box is the
  // component's rendered root — the width the declared minimum applies to.
  const squished: LayoutSquish[] = [];
  boxes.forEach((wrapper, w) => {
    const min = wrapper.pattern ? minWidths.get(wrapper.pattern) : undefined;
    if (min === undefined) return;
    const root = boxes.findIndex((b) => b.parent === w);
    if (root < 0 || !measurable(boxes[root])) return;
    const width = Math.round(boxes[root].width);
    if (width + TOLERANCE_PX >= min) return;
    squished.push({
      pattern: wrapper.pattern,
      patternPath: wrapper.patternPath,
      trait: wrapper.trait,
      widthPx: width,
      minWidthPx: min,
    });
  });

  return {
    viewport: m.viewport,
    documentOverflowPx: Math.max(0, m.documentScrollWidth - vw),
    offenders,
    scrollers,
    squished,
  };
}

export async function measureLayout(page: Page): Promise<LayoutMeasurement> {
  return page.evaluate(() => {
    const els = Array.from(document.body.querySelectorAll('*'));
    const index = new Map<Element, number>(els.map((el, i) => [el, i]));
    const boxes = els.map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const parentIdx = el.parentElement ? index.get(el.parentElement) : undefined;
      return {
        parent: parentIdx ?? -1,
        left: r.left,
        right: r.right,
        width: r.width,
        height: r.height,
        clipsX: cs.overflowX !== 'visible',
        overflowX: cs.overflowX,
        scrollOverflowX: el.scrollWidth - el.clientWidth,
        fixed: cs.position === 'fixed',
        hidden: cs.visibility === 'hidden' || cs.display === 'none' || el.closest('[aria-hidden="true"]') !== null,
        pattern: el.getAttribute('data-pattern'),
        patternPath: el.getAttribute('data-pattern-path'),
        trait: el.getAttribute('data-orb-trait'),
        tag: el.tagName.toLowerCase(),
        testId: el.getAttribute('data-testid'),
        className: typeof el.className === 'string' ? el.className : (el.getAttribute('class') ?? ''),
      };
    });
    return {
      viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
      documentScrollWidth: document.documentElement.scrollWidth,
      boxes,
    };
  });
}

export async function checkLayout(page: Page): Promise<LayoutReport> {
  return classifyLayout(await measureLayout(page), getPatternMinUsableWidths());
}
