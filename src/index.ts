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
export {
  Annotator,
  type Annotation,
  type AnnotationVerdict,
  type AnnotationCategory,
  type AnnotationPromptOptions,
} from './browser/annotator.js';

// Runtime state bridge
export {
  readVerificationSnapshot,
  readTraitStates,
  readTraitSnapshots,
  readEventLog,
  readRuntimeState,
  getTraitCurrentState,
  verifyTransitionAccepted,
  type OrbitalVerificationSnapshot,
  type TraitStateSnapshot,
} from './runtime/state-bridge.js';

// Entity data inspector
export { inspectEntityData, type EntityInspection } from './runtime/entity-inspector.js';

// DOM analysis
export {
  inspectDOM, type DOMInspection,
  detectViteErrorOverlay, type ViteOverlayResult,
} from './analysis/dom-inspector.js';
export { buildConsoleReport, type ConsoleReport } from './analysis/console-report.js';

// Report generation
export { buildJsonReport, writeJsonReport } from './report/json-report.js';
export { buildMarkdownReport, writeMarkdownReport } from './report/markdown-report.js';
export {
  writeTransitionLogJsonl,
  buildTransitionLogTxt,
  writeTransitionLogTxt,
} from './report/transition-log.js';
export {
  formatTestReport,
  formatTestReportPlain,
  writeTestReport,
  type TestReportEntry,
} from './report/test-report.js';

// Shared types
export type {
  VerifyResult,
  RuntimeState,
  ConsoleEntry,
  VerifyReport,
  TransitionLogEntry,
  VerifyCheck,
} from './util/types.js';

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

// Schema effect scanning (entity binding detection for verification gating)
export {
  scanEffectsForEntityBindings,
  hasAnyEntityListBinding,
  type EntityBindingScan,
} from './schema/effect-scanner.js';

// Schema walker — event classification + bindings + mutating effects
// (feeds VG2 / VG3 / VG4 / VG11a / VG11c gates). `BindingRoot` is
// re-exported from @almadar/core.
export {
  SchemaWalker,
  type BindingRoot,
  type EventClassification,
  type SchemaBinding,
  type MutatingEffectKind,
  type MutatingEffect,
} from './schema/walker.js';

// VG1 — portal slot presence probe. After render-ui-to-portal
// transitions, asserts the matching `#slot-<name>` element mounted
// with at least one child.
export {
  PORTAL_SLOTS,
  isPortalSlot,
  portalRendersFromTransition,
  probePortalSlots,
  probePortalSlotsAfterTransition,
  findTransition,
  type PortalSlot,
  type PortalSlotCheck,
  type ExpectedPortalRender,
} from './browser/portal-slots.js';

// VG6 — ref-trait invariant. Every trait reported via
// `getTraitSnapshots()` must have a non-empty state + event list.
export {
  checkRefTraitInvariant,
  assertRefTraitInvariant,
  type RefTraitInvariantCheck,
  type RefTraitInvariantResult,
} from './browser/ref-trait-invariant.js';

// VG11a — binding-to-DOM assertions. For every binding the schema
// says the trait's current state renders, resolve the expected value
// from config/payload/entity and assert it lands in the target slot.
export {
  probeBindingsAfterTransition,
  probeAllTraitBindings,
  type BindingCheck,
  type BindingAssertionResult,
} from './browser/binding-assertions.js';

// VG3 — click-path sample. After the programmatic engine walk, pick
// one user-dispatchable transition per trait and fire it via an actual
// DOM click so the button → bus → reducer plumbing is proven at least
// once per trait. Pass1's sendEvent coverage stays untouched; this
// augments with real click-through.
export {
  sampleClickPath,
  type ClickPathSampleCheck,
  type ClickPathTraitInput,
  type ClickPathOptions,
} from './browser/click-path.js';

// State walk engine (shared two-pass verification)
export { StateWalkEngine } from './engine/StateWalkEngine.js';
export type {
  EngineAdapter,
  TraitWalkConfig,
  EngineConfig,
  WalkResult,
} from './engine/types.js';

// Re-export state machine algorithms from @almadar/core
export {
  buildStateGraph,
  collectReachableStates,
  walkStatePairs,
  buildGuardPayloads,
  extractPayloadFieldRef,
  buildReplayPaths,
  buildEdgeCoveringWalk,
} from '@almadar/core';
