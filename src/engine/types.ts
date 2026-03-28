/**
 * State Walk Engine Types
 *
 * Adapter interface, configuration, and result types for the shared
 * two-pass state walk engine used by both orbital-verify and runtime-verify.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import type { WalkStep, EdgeWalkTransition } from '@almadar/core';
import type { TransitionLogEntry } from '../util/types.js';

/**
 * Adapter that tool-specific code provides to the engine.
 * Each tool implements this interface with its own event dispatch mechanism.
 */
export interface EngineAdapter {
  /** Send an event to the state machine runtime. Returns true if sent. */
  sendEvent(page: Page, event: string, payload: Record<string, unknown>): Promise<boolean>;

  /** Read the current state for a given trait. Returns null if unavailable. */
  getState(page: Page, traitName: string): Promise<string | null>;

  /** Wait for the state machine to settle after an event. */
  settle(page: Page): Promise<void>;

  /**
   * Attempt to trigger a transition via DOM interaction (button click, form fill).
   * Returns true if a DOM trigger was found and clicked.
   * Only used in Pass 2. If not provided, Pass 2 is skipped.
   */
  triggerViaDOM?(page: Page, step: WalkStep, traitName: string): Promise<boolean>;

  /**
   * Post-transition hook. Called after every step in both passes.
   * Use for screenshots, error checks, pattern assertions, etc.
   */
  onTransition?(page: Page, step: WalkStep, traitName: string, accepted: boolean): Promise<void>;

  /**
   * Reset the state machine to initial state.
   * Typically implemented as page reload + wait for runtime ready.
   */
  reset?(page: Page): Promise<void>;
}

/** Configuration for a single trait's walk. */
export interface TraitWalkConfig {
  traitName: string;
  initialState: string;
  transitions: EdgeWalkTransition[];
}

/** Engine-level configuration. */
export interface EngineConfig {
  /** Maximum time budget for the entire walk (ms). Default: 120000 */
  maxWalkMs: number;
  /** Time to wait after each event for state to settle (ms). Default: 1500 */
  settleMs: number;
  /** Whether to run Pass 2 (UI interaction coverage). Default: true */
  runPass2: boolean;
  /** Logger function. Default: console.log */
  log?: (message: string) => void;
}

/** Result of the engine walk for a set of traits. */
export interface WalkResult {
  /** Coverage keys exercised in "TraitName:from+EVENT->to" format */
  coveredKeys: string[];
  /** UI-triggered coverage keys in "TraitName:from+EVENT->to[ui]" format */
  uiCoveredKeys: string[];
  /** Errors encountered */
  errors: string[];
  /** Warnings */
  warnings: string[];
  /** Transition log entries for reporting */
  transitionLog: TransitionLogEntry[];
  /** Total transition count across all traits (excluding INIT) */
  totalTransitions: number;
}

export type { WalkStep, EdgeWalkTransition, TransitionLogEntry };
