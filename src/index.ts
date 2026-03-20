/**
 * @almadar/verify
 *
 * Shared Playwright verification utilities for Almadar runtime and compiled projects.
 *
 * Provides:
 * - Browser launch, navigation, console collection, screenshot capture
 * - Runtime state bridge (window.__orbitalVerification reader)
 * - DOM inspection for common error patterns
 * - Report generation (JSON and Markdown)
 * - Re-exports of @almadar/core state machine algorithms
 *
 * @packageDocumentation
 */

// Browser utilities
export { launchBrowser, type LaunchOptions } from './browser/launch.js';
export { ConsoleCollector } from './browser/console.js';
export { takeScreenshot, safeFileName } from './browser/screenshot.js';
export { navigateWithRetry, waitForRuntime } from './browser/navigate.js';

// Runtime state bridge
export {
  readVerificationSnapshot,
  readTraitStates,
  readEventLog,
  readRuntimeState,
  type OrbitalVerificationSnapshot,
} from './runtime/state-bridge.js';

// Entity data inspector
export { inspectEntityData, type EntityInspection } from './runtime/entity-inspector.js';

// DOM analysis
export { inspectDOM, type DOMInspection } from './analysis/dom-inspector.js';
export { buildConsoleReport, type ConsoleReport } from './analysis/console-report.js';

// Report generation
export { buildJsonReport, writeJsonReport } from './report/json-report.js';
export { buildMarkdownReport, writeMarkdownReport } from './report/markdown-report.js';

// Shared types
export type { VerifyResult, RuntimeState, ConsoleEntry, VerifyReport } from './util/types.js';

// Noise filters
export { isNoiseError, isNoiseWarning } from './util/filter.js';

// Retry utility
export { retry } from './util/retry.js';

// Interaction utilities (Playwright-based form filling, button clicking, pattern classification)
export {
  classifyTargetPattern,
  buildMinimalPayload,
  fillFormFields,
  generateFieldValue,
  clickSubmitAction,
  clickCloseAction,
  countEntityRows,
  type PatternClassification,
  type EntityFieldDef,
} from './browser/interaction.js';

// Data presence assertions (entity data visibility, edit pre-population)
export {
  assertEditPrePopulated,
  assertEntityDataVisible,
  assertViewDataVisible,
  assertFormFieldTypes,
  type EditPrePopulationResult,
  type EntityDataVisibleResult,
  type ViewDataResult,
  type FormFieldTypeResult,
  type ExpectedFieldType,
  type FieldTypeMismatch,
} from './browser/data-assertions.js';

// Re-export state machine algorithms from @almadar/core
export {
  buildStateGraph,
  collectReachableStates,
  walkStatePairs,
  buildGuardPayloads,
  extractPayloadFieldRef,
  buildReplayPaths,
} from '@almadar/core';
