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
export {
  takeScreenshot,
  takeScreenshotSections,
  safeFileName,
  type SectionScreenshotOptions,
} from './browser/screenshot.js';
export { navigateWithRetry, waitForRuntime } from './browser/navigate.js';
export {
  Annotator,
  type Annotation,
  type AnnotationVerdict,
  type AnnotationCategory,
  type AnnotationPromptOptions,
} from './browser/annotator.js';
export {
  runInteractiveSession,
  type InteractiveSessionOptions,
} from './browser/interactive-session.js';

// Runtime state bridge
export {
  readVerificationSnapshot,
  readTraitStates,
  readTraitSnapshots,
  readEventLog,
  readEventLogState,
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
  ReportCoverage,
} from './util/types.js';

// Noise filters
export { isNoiseError, isNoiseWarning } from './util/filter.js';

// Retry utility
export { retry } from './util/retry.js';

// orbital binary resolution (PATH-independent)
export { resolveOrbitalBin, resetOrbitalBinCache } from './util/orbital-bin.js';

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

// V4 dual-carry id-integrity mirror (`ORB_ID_*`) — the runtime-path twin of
// the Rust `id_integrity.rs` validator.
export { validateIdIntegrity } from './schema/id-integrity.js';

// Pure data exports from browser/portal-slots.ts. The Page-bound
// `probePortalSlots*` functions are internal to the kernel's
// `assertPortalPerStep` observer; consumers don't call them directly.
export {
  PORTAL_SLOTS,
  isPortalSlot,
  portalRendersFromTransition,
  findTransition,
  type PortalSlot,
  type ExpectedPortalRender,
} from './browser/portal-slots.js';

// Pure data exports from browser/catalog-probes.ts. Page-bound `probe*`
// helpers were removed in v3.0.0 — every check now happens via
// observers consuming `Frame[]` (see `observer/`).
export {
  collectCatalogBindings,
  pickBySegments,
  valueToText,
  collectMutationEffects,
  collectEmitDeclarations,
  type TransitionLike,
  type TraitListenerLike,
  type CatalogBinding,
  type MutationEffect,
  type EmitDeclaration,
  type EntityFieldLike,
} from './browser/catalog-probes.js';

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
  TestKind,
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
  PlanTickInput,
} from './planner/types.js';
export { planWalk } from './planner/plan-walk.js';
export { planInitCredit } from './planner/plan-init-credit.js';
export { planEmitSweep } from './planner/plan-emit-sweep.js';
export { planReplayTo } from './planner/plan-replay-to.js';
export { planTickTests } from './planner/plan-tick-tests.js';
export {
  decorateWithTriggerKind,
  type DecorateInput,
} from './planner/plan-dom-decoration.js';
export { planClickPathSamples } from './planner/plan-click-path-samples.js';
export { extractTraitWalkConfigs } from './planner/extract-trait-walk-configs.js';
export {
  planContractEvents,
  type ContractRegistry,
  type ContractRegistryEntry,
} from './planner/plan-contract-events.js';
export { planDataMutationTests } from './planner/plan-data-mutation-tests.js';
export { planInteractionTests } from './planner/plan-interaction-tests.js';
export { planUserCrudFlow } from './planner/plan-user-crud-flow.js';

// Observer — pure consumers of the Frame stream
export type {
  Observer,
  CoverageMetric,
  BindingDelta,
  BindingMatch,
  CascadeRule,
  MutationRule,
  PortalExpectation,
  FieldContentCheck as ObserverFieldContentCheck,
  EntityRowContentVerdict,
  Verdict,
  ReportShape,
  FrontierSummary,
} from './observer/types.js';
export { coverage } from './observer/coverage.js';
export { assertMutation } from './observer/assert-mutation.js';
export { assertCascade } from './observer/assert-cascade.js';
export { assertGuardParity } from './observer/assert-guard-parity.js';
export { assertPortalSlots } from './observer/assert-portal.js';
export { probeBindings as probeBindingsFromFrame } from './observer/probe-bindings.js';
export { assertRefTraitInvariantOverFrames } from './observer/assert-ref-trait-invariant.js';
export { assertClickPathSample } from './observer/assert-click-path-sample.js';
export { assertContractEventFired } from './observer/assert-contract-event-fired.js';
export { assertDataMutation } from './observer/assert-data-mutation.js';
export { assertCrudFlow } from './observer/assert-crud-flow.js';
export { assertPortalPerStep } from './observer/assert-portal-per-step.js';
export { assertInteractionPattern } from './observer/assert-interaction-pattern.js';
export { auditListens, type ListensAuditResult } from './observer/click-wiring-audit.js';
export { lintWiring, type WiringLintFinding, type WiringLintResult, type WiringLintSeverity } from './observer/wiring-lint.js';
export { report as buildFrameReport, type ReportInput } from './observer/report.js';
export { verdictToChecks, type VerdictCheck } from './observer/verdict-checks.js';

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
  playCircuitStep,
  type PlayCircuitStepInput,
  type PlayCircuitStepResult,
} from './driver/play-step.js';
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
  type FakeDriverOptions,
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
export { isUiFactoryBoard } from './pipeline/ui-factory-board.js';

export {
  scoreStructuralQuality,
  gradeScreenshotQuality,
  VisionQualityGradingError,
  type StructuralQualityReport,
  type OrbitalStructuralFacts,
  type AggregateStructuralFacts,
  type VisionQualityReport,
} from './quality/index.js';
