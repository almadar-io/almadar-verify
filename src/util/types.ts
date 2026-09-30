/**
 * Shared types for verification tools.
 *
 * @packageDocumentation
 */

/** Result of a single verification check */
export interface VerifyResult {
  name: string;
  status: 'pass' | 'error' | 'warning';
  errors: string[];
  warnings: string[];
  screenshotPath: string | null;
  durationMs: number;
  runtimeState?: RuntimeState;
  layout?: LayoutReport;
}

/** A root element sticking out of the viewport, attributed to the rendered
 *  pattern it sits in (`pattern`) and the deepest overflowing pattern inside
 *  it (`deepestPattern`, usually the actual culprit). */
export interface LayoutAttribution {
  pattern: string | null;
  patternPath: string | null;
  trait: string | null;
  tag: string;
  testId: string | null;
  className: string;
}

export interface LayoutOffender extends LayoutAttribution {
  deepestPattern: string | null;
  widthPx: number;
  overflowRightPx: number;
  overflowLeftPx: number;
}

export interface LayoutReport {
  viewport: { width: number; height: number };
  documentOverflowPx: number;
  offenders: LayoutOffender[];
  /** Clipping containers whose content is wider than they are — a deliberate
   *  table scroller, a truncated label, or a page scrolling sideways. */
  scrollers: LayoutScroller[];
  /** Rendered patterns narrower than their declared `minUsableWidth`. */
  squished: LayoutSquish[];
}

export interface LayoutSquish {
  pattern: string | null;
  patternPath: string | null;
  trait: string | null;
  widthPx: number;
  minWidthPx: number;
}

export interface LayoutScroller extends LayoutAttribution {
  overflowX: string;
  widthPx: number;
  hiddenContentPx: number;
}

import type { EntityData, FieldValue } from '@almadar/core';

/** Runtime state snapshot read from window.__orbitalVerification */
export interface RuntimeState {
  traits: Record<string, { currentState: string; context: Record<string, FieldValue> }>;
  entities: EntityData;
  events: string[];
  guards: Record<string, boolean>;
}

/** A single console message captured from the browser */
export interface ConsoleEntry {
  type: 'error' | 'warning' | 'info';
  text: string;
  timestamp: number;
}

/** A single verification check result (used by orbital-verify) */
export interface VerifyCheck {
  label: string;
  passed: boolean;
  detail?: string;
}

/** Coverage gate numbers (unique covered transitions / declared total). */
export interface ReportCoverage {
  covered: number;
  total: number;
  ratio: number;
}

/** Full report of a verification run */
export interface VerifyReport {
  timestamp: string;
  url: string;
  mode: 'playground' | 'app';
  summary: {
    total: number;
    pass: number;
    error: number;
    warning: number;
  };
  results: VerifyResult[];
  coverage?: ReportCoverage;
}
