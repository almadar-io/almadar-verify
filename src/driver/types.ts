/**
 * Driver type contracts.
 *
 * `Driver<Ctx>` is the kernel's only impure boundary. The kernel never
 * imports `playwright` (or any other automation library); only files
 * under `driver/impls/<transport>.ts` may. Each impl narrows `Ctx` to
 * extend `DriverContext` with its runtime handle (Playwright Page,
 * Puppeteer Page, an in-process `FakeRuntime` for unit tests, etc.).
 *
 * The four required methods (`sendEvent`, `getState`, `triggerDOM`,
 * `snapshot`) are everything `tick()` needs to produce a Frame from a
 * planned step. Optional `reset` / `beforeTrait` / `settle` are
 * lifecycle hooks the kernel calls if provided.
 *
 * @packageDocumentation
 */

import type {
  EffectTrace,
  EntityData,
  EventLogEntry,
  EventPayload,
  ServerResponseTrace,
  TraitConfig,
  VerificationSnapshot,
} from '@almadar/core';
import type { ConsoleEntry } from '../util/types.js';
import type { DomSnapshot } from '../frame/types.js';
import type { ExtendedWalkStep } from '../planner/types.js';
import type { TraitWalkConfig } from '../engine/types.js';

/**
 * Base context the kernel sees. Driver impls extend this with their
 * runtime handle. The kernel only reads `outputDir` and `trait`; the
 * runtime handle is opaque.
 */
export interface DriverContext {
  outputDir: string;
  trait: TraitWalkConfig;
}

/** Result of a single `sendEvent` call. */
export interface SendResult {
  sent: boolean;
  serverResponse: ServerResponseTrace | null;
}

/**
 * Result of a single `snapshot` call. Carries every observation
 * `tick()` needs to assemble a Frame: the runtime snapshot (core type,
 * never re-shaped), the DOM snapshot (verify-owned), per-channel new
 * entries since previous snapshot, and the latest entity store.
 */
export interface SnapshotResult {
  runtimeSnapshot: VerificationSnapshot;
  dom: DomSnapshot;
  /** New JS-console entries since previous snapshot. */
  consoleAdded: ReadonlyArray<ConsoleEntry>;
  /** New bus event log entries since previous snapshot. */
  eventLogAdded: ReadonlyArray<EventLogEntry>;
  /** Effect run records from the most recent transition trace. */
  effectResults: ReadonlyArray<EffectTrace>;
  /** Server response if the last dispatch round-tripped to the server. */
  serverResponse: ServerResponseTrace | null;
  /** Raw entity store; `tick()` derives `EntityChange[]` against the previous frame. */
  entityData: EntityData;
  /** Path on disk to a screenshot taken at this moment, or null if disabled. */
  screenshotPath: string | null;
}

/**
 * The driver contract. Generic over `Ctx` so each impl can carry its
 * own runtime handle without the kernel knowing.
 */
export interface Driver<Ctx extends DriverContext = DriverContext> {
  /**
   * Send an event programmatically via the runtime bus.
   *
   * `traitScope` is the qualified `App.Trait` (or `Orbital.Trait`)
   * scope under which the dispatching trait subscribes — codegen
   * emits `useUIEvents(enqueueEvent, '${traitScope}', ...)` and the
   * bus key becomes `UI:${traitScope}.${event}`. The kernel passes
   * the dispatching step's scope so the bridge can construct the
   * qualified key (gap #13). Optional for legacy / system-scope
   * dispatches.
   */
  sendEvent(
    ctx: Ctx,
    event: string,
    payload: EventPayload,
    traitScope?: string,
  ): Promise<SendResult>;

  /** Read the current state for the given trait. Returns null if unknown. */
  getState(ctx: Ctx, traitName: string): Promise<string | null>;

  /**
   * Trigger via DOM. Returns true iff the event was delivered (an
   * affordance was found and clicked, or the impl dispatched a
   * payload-correct bus event itself — e.g. crud-delete when no delete
   * button exists but the receiver transition requires a row `id`).
   * Falls back to `sendEvent` at the kernel level when this returns false.
   *
   * `traitScope` is the same qualified `Orbital.Trait` scope the kernel
   * passes to `sendEvent` — impls that self-dispatch need it to build
   * the qualified bus key.
   */
  triggerDOM(ctx: Ctx, step: ExtendedWalkStep, traitScope?: string): Promise<boolean>;

  /**
   * Capture the runtime snapshot, DOM snapshot, console + event log
   * deltas, screenshot, and current entity store. The kernel calls
   * this exactly once per step, AFTER `settle`.
   */
  snapshot(ctx: Ctx, step: ExtendedWalkStep | null): Promise<SnapshotResult>;

  /** Reset the runtime to its initial state (typically a page reload). */
  reset(ctx: Ctx): Promise<void>;

  /** Settle hook between event dispatch and snapshot. */
  settle(ctx: Ctx): Promise<void>;

  /** Per-trait setup (navigate to the trait's route, etc). Optional. */
  beforeTrait?(ctx: Ctx): Promise<void>;

  /**
   * Apply a trait `config` override and re-render the behavior, WITHOUT
   * recompiling — used by the config sweep. On the playground this re-registers
   * the active schema with the overrides and waits for the re-render. Optional:
   * drivers that can't re-configure leave it undefined and the sweep is skipped.
   */
  applyConfig?(ctx: Ctx, traitName: string, config: TraitConfig): Promise<void>;
}
