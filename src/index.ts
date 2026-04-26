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
  framesToReportTransitions,
  type TestReportEntry,
  type ReportTransition,
} from './report/test-report.js';

// Shared types
export type {
  VerifyResult,
  RuntimeState,
  ConsoleEntry,
  VerifyReport,
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
  fillFormFieldsWithValues,
  type FilledFormValues,
  type FilledFormResult,
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
  type PortalProbeOptions,
} from './browser/portal-slots.js';

// VG6 — ref-trait invariant. Every trait reported via
// `getTraitSnapshots()` must have a non-empty state + event list.
export {
  checkRefTraitInvariant,
  assertRefTraitInvariant,
  type RefTraitInvariantCheck,
  type RefTraitInvariantResult,
} from './browser/ref-trait-invariant.js';

// Catalog-effect helpers — pure schema-shape functions PLUS the
// Page-bound probe* helpers consumers haven't yet migrated to the
// Frame-based observers. The pure helpers are the canonical surface;
// the probe* helpers stay re-exported as a transitional convenience
// for tooling that calls them outside the new pipeline (e.g.
// orbital-verify-unified's interaction tests). They WILL be removed
// once their callers migrate to observer/assert-mutation +
// observer/assert-cascade + observer/probe-bindings.
export {
  collectCatalogBindings,
  pickBySegments,
  valueToText,
  collectMutationEffects,
  collectEmitDeclarations,
  probeBindingsForTransition,
  probeMutationDelta,
  probeCascadeCount,
  probeCascadeFlowDelta,
  probeEntityRowContent,
  probeListRender,
  type TransitionLike,
  type TraitListenerLike,
  type CatalogBinding,
  type BindingProbeResult,
  type MutationEffect,
  type MutationCheckResult,
  type EmitDeclaration,
  type CascadeCheckResult,
  type CascadeFlowDeltaResult,
  type EntityFieldLike,
  type FieldContentCheck,
  type EntityRowContentResult,
  type ListRenderResult,
} from './browser/catalog-probes.js';

// Transitional re-exports — orbital-verify-unified still calls these
// outside the kernel walker. Will be removed once their callers
// migrate to the Frame-based observers. The Page-bound impls live in
// browser/* and continue to work; they're just not part of the
// pipeline.
export {
  probeBindingsAfterTransition,
  probeAllTraitBindings,
  type BindingCheck,
  type BindingAssertionResult,
} from './browser/binding-assertions.js';
export {
  sampleClickPath,
  sampleClickPathsPerSite,
  type ClickPathSampleCheck,
  type ClickPathTraitInput,
  type ClickPathOptions,
  type ClickPathRenderSite,
} from './browser/click-path.js';

// `TraitWalkConfig` is the per-trait input shape `runVerification`
// consumes. The legacy `StateWalkEngine` / `EngineAdapter` /
// `EngineConfig` / `WalkResult` types were removed in v2.0.0.
export type { TraitWalkConfig } from './engine/types.js';

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

// ── Phase 0 lift — Frame-based temporal pipeline ────────────────────
//
// New three-layer architecture: pure planner → thin driver → pure
// observers. The kernel never imports playwright; only `driver/impls/`
// (added in Phase 1) does. See `docs/Almadar_Verify_Frames.md` /
// `/home/osamah/.claude/plans/structured-hatching-music.md` for the
// full design.

// Frame — the temporal unit
export type {
  Frame,
  FrameCause,
  TriggerKind,
  ConsoleDelta,
  EventLogDelta,
  EntityChange,
  EntityRowChange,
  DomSnapshot,
} from './frame/types.js';
export {
  keyOf,
  diffConsole,
  diffEventLog,
  diffEntities,
  makeWalkFrame,
  makeInitFrame,
  type MakeFrameInput,
  type MakeInitFrameInput,
} from './frame/factory.js';

// Planner — pure planners over @almadar/core types
export type {
  ExtendedWalkStep,
  PlanWalkInput,
  PlanEmitInput,
  PlanReplayInput,
} from './planner/types.js';
export { planWalk } from './planner/plan-walk.js';
export { planInitCredit } from './planner/plan-init-credit.js';
export { planEmitSweep } from './planner/plan-emit-sweep.js';
export { planReplayTo } from './planner/plan-replay-to.js';
export {
  decorateWithTriggerKind,
  type DecorateInput,
} from './planner/plan-dom-decoration.js';

// Observer — pure consumers of the Frame stream
export type {
  Observer,
  CoverageMetric,
  BindingDelta,
  BindingMatch,
  CascadeRule,
  MutationRule,
  FieldContentCheck as ObserverFieldContentCheck,
  EntityRowContentVerdict,
  Verdict,
  ReportShape,
} from './observer/types.js';
export { coverage } from './observer/coverage.js';
export { assertMutation } from './observer/assert-mutation.js';
export { assertCascade } from './observer/assert-cascade.js';
export { assertPortalSlots } from './observer/assert-portal.js';
export { probeBindings as probeBindingsFromFrame } from './observer/probe-bindings.js';
export { assertRefTraitInvariantOverFrames } from './observer/assert-ref-trait-invariant.js';
export { report as buildFrameReport, type ReportInput } from './observer/report.js';

// Driver — the I/O boundary. `Driver<Ctx>` is generic over context;
// impls live under `driver/impls/<transport>.ts` and are the only files
// that import transport libraries.
export type {
  Driver,
  DriverContext,
  SendResult,
  SnapshotResult,
} from './driver/types.js';
export { tick } from './driver/tick.js';
export {
  createPlaywrightDriver,
  type PlaywrightDriverContext,
  type PlaywrightBridge,
  type CreatePlaywrightDriverOptions,
} from './driver/impls/playwright.js';
export {
  createFakeDriver,
  FakeRuntime,
  type FakeDriverContext,
} from './driver/impls/fake.js';
export {
  createDefaultSnapshot,
  type DefaultSnapshotOptions,
} from './driver/helpers/default-snapshot.js';
export {
  createDefaultDomTrigger,
  type DefaultDomTriggerOptions,
} from './driver/helpers/default-dom-trigger.js';

// Pipeline — composes plan → fold(tick) → observers → report.
export {
  runVerification,
  type RunVerificationInput,
  type RunVerificationOutput,
} from './pipeline/index.js';
