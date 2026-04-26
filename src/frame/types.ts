/**
 * Frame — the temporal unit of a verification run.
 *
 * A `Frame` is a pure data record describing one moment in the world model:
 * an event was caused (auto-init, walker step, DOM click, bus dispatch),
 * the runtime processed it, the DOM rendered, the entity store mutated,
 * and the JS console plus bus event log advanced. The full observation is
 * captured in one immutable record; observers (`coverage`, `assertMutation`,
 * `assertCascade`, `probeBindings`, `report`) operate on `Frame[]` without
 * ever reaching back into the runtime.
 *
 * The frame mirrors the .orb identity documented in CLAUDE.md / std memory:
 * each transition is a "frame" in the world model. A verification run is the
 * temporal sequence of those frames replayed externally.
 *
 * Every shape here is grounded in `@almadar/core` types where one already
 * exists. The only verify-owned shapes are observation surfaces with no
 * core counterpart (browser JS console, DOM probing).
 *
 * @packageDocumentation
 */

import type {
  EventPayload,
  EffectTrace,
  ServerResponseTrace,
  VerificationSnapshot,
  EventLogEntry,
  EntityRow,
} from '@almadar/core';
import type { ConsoleEntry } from '../util/types.js';
import type { PortalSlot } from '../browser/portal-slots.js';

/**
 * Why a frame exists. `auto-init` is the synthetic boot-INIT credit the
 * kernel prepends per trait (the runtime auto-fires INIT on mount).
 * `bus` is a programmatic `sendEvent` dispatch. `dom` is a DOM-trigger
 * (button click, form submit). `replay` is a repositioning step inserted
 * by `buildEdgeCoveringWalk` to reach a state with uncovered outgoing
 * edges.
 */
export type TriggerKind = 'bus' | 'dom' | 'auto-init' | 'replay';

/**
 * Tag that lets observers categorize the verdicts they emit. The base
 * planners (`planWalk`, `planInitCredit`, `planEmitSweep`,
 * `planReplayTo`) leave this undefined; v3.0.0 planner extensions
 * (`planClickPathSamples`, `planInteractionTests`, etc.) stamp it with
 * the matching kind. Mirrors `ExtendedWalkStep.testKind`.
 */
export type TestKind = 'interaction' | 'data-mutation' | 'contract' | 'click-path';

/**
 * The cause that produced a frame. Carries the same information as a
 * `WalkStep` plus the trait it targeted, how it was fired, and any
 * observation hints (`expectedRowDelta`, `expectedPattern`) the
 * planner attached to the originating step. Observers read these
 * directly from the cause — no need to thread the plan separately.
 */
export interface FrameCause {
  traitName: string;
  from: string;
  event: string;
  to: string;
  guardCase: 'pass' | 'fail' | null;
  triggerKind: TriggerKind;
  isRepositioning: boolean;
  /**
   * v3.0.0: test-kind tag carried from the originating
   * `ExtendedWalkStep.testKind`. Observers like `assertClickPathSample`
   * use this to filter `Frame[]` to just the frames their verdicts
   * apply to.
   */
  testKind?: TestKind;
  /**
   * v3.0.0: per-entity row-count delta the originating step expects
   * the observer to see in `frame.entityChanges` after settle.
   * Carried from `ExtendedWalkStep.expectedRowDelta`.
   */
  expectedRowDelta?: { entityName: string; delta: number };
  /**
   * v3.0.0: pattern observer expects to find mounted in
   * `frame.domSnapshot.portals` after this step settles.
   * Carried from `ExtendedWalkStep.expectedPattern`.
   */
  expectedPattern?: string;
  /**
   * v3.0.3: full coverage key carried from the originating step. The
   * coverage observer's numerator (deduped `keyOf(cause)`) needs to
   * match the denominator (deduped `step.coverageKey`) — and extension
   * planners encode test-kind suffixes into their keys
   * (`[interaction]`, `[click-path:slot]`, `[data-mutation:create]`,
   * etc.) that the legacy `keyOf` formula doesn't reproduce. Carrying
   * the key on the cause closes that gap so extension steps are
   * actually creditable as covered.
   */
  coverageKey?: string;
  /**
   * v3.2.0: the success-emit event key declared by the originating
   * step's persist / fetch / call-service / ref effect (in its
   * `{ emit: { success: "X" } }` options block). `assertDataMutation`
   * checks `frame.serverResponse.emittedEvents.includes(this)` as the
   * canonical signal that the effect ran successfully — independent of
   * whether the mock store reflects the row delta.
   */
  expectedSuccessEvent?: string;
  /**
   * v3.2.3: the form's `submitEvent` carried from the originating step.
   * The DOM trigger uses `[data-testid="action-<submitEvent>"]` to find
   * and click the Save button. No fallback heuristics.
   */
  submitEvent?: string;
}

/**
 * New entries appended to the Playwright JS-console buffer since the
 * previous frame. `ConsoleEntry` is verify-owned because the JS console
 * is a transport-layer concept (Playwright captures it, not the runtime).
 */
export interface ConsoleDelta {
  added: ReadonlyArray<ConsoleEntry>;
  newErrors: number;
  newWarnings: number;
}

/**
 * New entries appended to the bus event log since the previous frame.
 * `EventLogEntry` is the canonical bus log shape from core.
 */
export interface EventLogDelta {
  added: ReadonlyArray<EventLogEntry>;
}

/**
 * Per-entity change since previous frame. Carries the actual rows
 * (not just counts) so observers can do BOTH count-based mutation
 * checks (VG11b/d) AND per-field content checks (VG11f) as pure
 * functions over `Frame[]` without re-reading the runtime.
 *
 * `added` / `removed` are diffed by `EntityRow.id`. `changed` holds
 * rows whose `id` exists in both snapshots but whose field values
 * differ; `fieldsChanged` lists the keys whose `FieldValue` is not
 * structurally equal across before/after.
 */
export interface EntityChange {
  entityName: string;
  before: ReadonlyArray<EntityRow>;
  after: ReadonlyArray<EntityRow>;
  added: ReadonlyArray<EntityRow>;
  removed: ReadonlyArray<EntityRow>;
  changed: ReadonlyArray<EntityRowChange>;
}

export interface EntityRowChange {
  /** The shared `id` between before and after rows. */
  id: string;
  before: EntityRow;
  after: EntityRow;
  /** Field names whose values differ between before and after. */
  fieldsChanged: ReadonlyArray<string>;
}

/**
 * What the DOM looked like at frame capture. Verify-owned because the
 * DOM is a transport concept; the core runtime exposes its semantic
 * snapshot via `VerificationSnapshot`.
 */
export interface DomSnapshot {
  url: string;
  /** Count summary keyed by entity name; derived from `EntityChange.after.length`. */
  rowsByEntity: Record<string, number>;
  portals: ReadonlyArray<{
    slot: PortalSlot;
    mounted: boolean;
    childCount: number;
  }>;
  /** Bounded sample (256 chars) of visible text — used for fast diffing without full DOM serialization. */
  visibleTextSample: string;
}

/**
 * One moment in the verification stream.
 *
 * Every observer in `observer/` reads from `Frame[]` and returns a typed
 * verdict / metric / report. None of them touch a Playwright `Page` or
 * the runtime — all observations are precomputed here by `tick()`.
 */
export interface Frame {
  /** 0-based position in the temporal stream. */
  index: number;
  /** Milliseconds since epoch — matches `EventLogEntry.timestamp` and `TransitionTrace.timestamp`. */
  timestamp: number;
  cause: FrameCause;

  /** State machine state from `runtimeSnapshot.traits[*].currentState` BEFORE the cause fired. Null on the synthetic auto-init Frame. */
  stateBefore: string | null;
  /** State AFTER the cause settled. */
  stateAfter: string | null;
  /** The payload sent on the bus (or `{}` for auto-init / replay). */
  payload: EventPayload;
  /** The event key fired (mirrors `cause.event`; carried separately for direct observer access). */
  eventFired: string;

  /** Full runtime snapshot captured after settle. Core type — never re-shaped by verify. */
  runtimeSnapshot: VerificationSnapshot;
  /** DOM observation surface. */
  domSnapshot: DomSnapshot;
  /** New JS-console entries since previous frame. */
  consoleDelta: ConsoleDelta;
  /** New bus event log entries since previous frame. */
  eventLogDelta: EventLogDelta;
  /** Per-entity changes since previous frame; rows + diffs, not just counts. */
  entityChanges: ReadonlyArray<EntityChange>;

  /** Effect run records from the most recent `TransitionTrace`. Empty for auto-init. */
  effectResults: ReadonlyArray<EffectTrace>;
  /** Server's response if the cause forwarded to the server; null otherwise. */
  serverResponse: ServerResponseTrace | null;

  /** Path on disk to the screenshot taken after settle, or null if screenshots disabled. */
  screenshotPath: string | null;

  /** Whether the runtime accepted the transition (state moved as expected, or guard-fail held). */
  accepted: boolean;
  errors: ReadonlyArray<string>;
  warnings: ReadonlyArray<string>;
}
