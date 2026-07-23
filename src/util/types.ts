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
