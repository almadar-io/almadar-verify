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

/** Runtime state snapshot read from window.__orbitalVerification */
export interface RuntimeState {
  traits: Record<string, { currentState: string; context: unknown }>;
  entities: Record<string, unknown[]>;
  events: string[];
  guards: Record<string, boolean>;
}

/** A single console message captured from the browser */
export interface ConsoleEntry {
  type: 'error' | 'warning' | 'info';
  text: string;
  timestamp: number;
}

/** A single transition captured during browser verification */
export interface TransitionLogEntry {
  timestamp: string;
  trait: string;
  from: string;
  event: string;
  payload: Record<string, unknown>;
  serverResponse: Record<string, unknown> | null;
  to: string;
  serverDataCounts: Record<string, number>;
  effectResults: unknown[];
  domEntityCount: number;
  screenshot?: string;
  /** Captured [almadar:*] log lines (client + server) during this transition */
  logs?: string[];
}

/** A single verification check result (used by orbital-verify) */
export interface VerifyCheck {
  label: string;
  passed: boolean;
  detail?: string;
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
}
