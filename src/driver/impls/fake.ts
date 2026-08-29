/**
 * `createFakeDriver` — in-process Driver impl for unit tests.
 *
 * Implements the four required Driver methods without a browser. Holds
 * minimal state (current state per trait, EntityData store, event log,
 * console buffer) and processes `sendEvent` by walking the trait's
 * declared transitions. `triggerDOM` routes to `sendEvent` (matching
 * the kernel's fallback behavior). `snapshot` returns the current
 * runtime state in `VerificationSnapshot` shape.
 *
 * Tests that exercise `tick` / `runVerification` against a known
 * fixture use this driver; they run in milliseconds with no Playwright,
 * no Vite, no playground.
 *
 * @packageDocumentation
 */

import type {
  EffectTrace,
  EntityData,
  EntityRow,
  EventLogEntry,
  EventPayload,
  SExpr,
  ServerResponseTrace,
  TraitStateSnapshot,
  VerificationSnapshot,
} from '@almadar/core';
import type { ConsoleEntry } from '../../util/types.js';
import type { ExtendedWalkStep } from '../../planner/types.js';
import type { TraitWalkConfig } from '../../engine/types.js';
import type { Driver, DriverContext, SendResult, SnapshotResult } from '../types.js';

/** What the FakeDriver carries on its context. */
export interface FakeDriverContext extends DriverContext {
  runtime: FakeRuntime;
}

/** Options for {@link createFakeDriver}. */
export interface FakeDriverOptions {
  /**
   * Guard evaluator hook. When a matched transition carries a guard
   * (`hasGuard: true`), `FakeRuntime.dispatch` calls this with the
   * transition's guard expression and the current dispatch's
   * `{traitName, event, payload}` — a `false` result blocks the
   * transition exactly like a real guard-fail (state holds, the event
   * still lands in the log). Absent hook = unconditional dispatch (the
   * pre-existing behavior every current caller relies on).
   */
  evaluateGuard?: (guard: SExpr, ctx: { traitName: string; event: string; payload: EventPayload }) => boolean;
}

/** In-process state machine + entity store + event log. */
export class FakeRuntime {
  /** Map of traitName → currentState. */
  private states = new Map<string, string>();
  /** Per-entity row storage. */
  private entities: { [name: string]: EntityRow[] } = {};
  /** Bus event log; cleared per snapshot diff. */
  private eventLog: EventLogEntry[] = [];
  /** JS console buffer; cleared per snapshot diff. */
  private consoleBuffer: ConsoleEntry[] = [];
  /** Cumulative cascade events per trait (matches TraitStateSnapshot.cascadeReceived). */
  private cascade = new Map<string, Array<{ event: string; payload?: EventPayload; timestamp: number }>>();
  /** Last event dispatched to each trait. */
  private lastDispatched = new Map<string, { event: string; payload?: EventPayload; timestamp: number }>();
  /** Effect traces from the most recent transition. */
  private lastEffectResults: EffectTrace[] = [];
  /** `traitName::event` pairs the API boundary rejects (validation fail):
   *  dispatch records the event but does NOT advance and returns a
   *  `success:false` serverResponse. Simulates the compiled server's
   *  payload-validator rejecting a malformed payload. */
  private rejected = new Set<string>();

  constructor(
    private traits: TraitWalkConfig[],
    private options: FakeDriverOptions = {},
  ) {
    this.reset();
  }

  /** Make `(traitName, event)` dispatches fail server-side validation. */
  rejectEvent(traitName: string, event: string): void {
    this.rejected.add(`${traitName}::${event}`);
  }

  reset(): void {
    this.states.clear();
    this.entities = {};
    this.eventLog = [];
    this.consoleBuffer = [];
    this.cascade.clear();
    this.lastDispatched.clear();
    this.lastEffectResults = [];
    for (const trait of this.traits) {
      this.states.set(trait.traitName, trait.initialState);
    }
  }

  /**
   * Process a sendEvent. Walk the trait's transitions to find one that
   * matches `(currentState, event)`; if found, advance. Returns the
   * `to` state on success, null on no-op (no matching transition).
   */
  dispatch(traitName: string, event: string, payload: EventPayload): { to: string | null; serverResponse: ServerResponseTrace | null } {
    const trait = this.traits.find((t) => t.traitName === traitName);
    if (trait === undefined) return { to: null, serverResponse: null };

    const current = this.states.get(traitName) ?? trait.initialState;

    if (this.rejected.has(`${traitName}::${event}`)) {
      // API-boundary validation rejected the payload: record the attempt,
      // do not advance, surface a `success:false` server trace.
      this.eventLog.push({ type: event, payload, timestamp: Date.now() });
      return {
        to: null,
        serverResponse: {
          orbitalName: traitName,
          success: false,
          clientEffects: 0,
          dataEntities: {},
          emittedEvents: [],
          error: `Payload validation failed for event '${event}'`,
          timestamp: Date.now(),
        },
      };
    }

    // Arm selection mirrors StateMachineCore.processEvent: candidates in
    // declaration order, first unguarded arm or first passing guard wins —
    // the standard guarded-arm → unguarded-fallback pattern must advance,
    // not report a false block.
    const candidates = trait.transitions.filter(
      (t) => t.from === current && t.event === event,
    );
    if (candidates.length === 0) {
      // Bus dispatch with no matching transition is recorded as a
      // cascade event but doesn't advance the state machine.
      this.eventLog.push({ type: event, payload, timestamp: Date.now() });
      return { to: null, serverResponse: null };
    }

    let transition: (typeof candidates)[0] | undefined;
    for (const arm of candidates) {
      if (arm.hasGuard && arm.guard !== undefined && this.options.evaluateGuard) {
        if (!this.options.evaluateGuard(arm.guard, { traitName, event, payload })) continue;
      }
      transition = arm;
      break;
    }
    if (transition === undefined) {
      // Every arm's guard failed: record the dispatch attempt, do not
      // advance — mirrors the "no matching transition" branch above.
      this.eventLog.push({ type: event, payload, timestamp: Date.now() });
      return { to: null, serverResponse: null };
    }

    this.states.set(traitName, transition.to);
    this.eventLog.push({ type: event, payload, timestamp: Date.now() });
    this.lastDispatched.set(traitName, { event, payload, timestamp: Date.now() });
    this.lastEffectResults = [];

    return { to: transition.to, serverResponse: null };
  }

  getState(traitName: string): string | null {
    return this.states.get(traitName) ?? null;
  }

  /**
   * Test-only: force a trait's current state, bypassing transition
   * validation. Used by fixtures simulating a runtime settle race — a
   * mocked effect resolving (and auto-advancing the state machine)
   * inside the driver's settle window, so the observed state differs
   * from the transition table's naive `to`.
   */
  setState(traitName: string, state: string): void {
    this.states.set(traitName, state);
  }

  /**
   * Seed an entity row directly. Useful for fixtures that need a
   * pre-populated store.
   */
  seed(entityName: string, rows: EntityRow[]): void {
    this.entities[entityName] = [...rows];
  }

  /**
   * Add a cascade event for a trait. Used by fixtures simulating
   * downstream listener traits.
   */
  pushCascade(traitName: string, event: string, payload?: EventPayload): void {
    const list = this.cascade.get(traitName) ?? [];
    list.push({ event, payload, timestamp: Date.now() });
    this.cascade.set(traitName, list);
  }

  /**
   * Pull and clear the new console + event log entries since the last
   * snapshot. `tick`'s diff helpers consume these.
   */
  drain(): { consoleAdded: ConsoleEntry[]; eventLogAdded: EventLogEntry[] } {
    const consoleAdded = this.consoleBuffer.slice();
    const eventLogAdded = this.eventLog.slice();
    this.consoleBuffer = [];
    this.eventLog = [];
    return { consoleAdded, eventLogAdded };
  }

  /** Build a `VerificationSnapshot` reflecting current runtime state. */
  snapshot(): VerificationSnapshot {
    const traits: TraitStateSnapshot[] = this.traits.map((trait) => {
      const currentState = this.states.get(trait.traitName) ?? trait.initialState;
      const lastDispatched = this.lastDispatched.get(trait.traitName);
      return {
        traitName: trait.traitName,
        currentState,
        states: Array.from(new Set(trait.transitions.flatMap((t) => [t.from, t.to]))).filter(
          (s) => s !== '*',
        ),
        events: Array.from(new Set(trait.transitions.map((t) => t.event))),
        data: this.snapshotEntityData(),
        lastEventDispatched: lastDispatched,
        cascadeReceived: this.cascade.get(trait.traitName) ?? [],
      };
    });
    return {
      checks: [],
      transitions: [],
      bridge: null,
      summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
      traits,
    };
  }

  entityData(): EntityData {
    return this.snapshotEntityData();
  }

  effectResults(): EffectTrace[] {
    return this.lastEffectResults.slice();
  }

  private snapshotEntityData(): EntityData {
    const out: EntityData = {};
    for (const [name, rows] of Object.entries(this.entities)) {
      out[name] = rows.slice();
    }
    return out;
  }
}

export function createFakeDriver(traits: TraitWalkConfig[], options?: FakeDriverOptions): {
  driver: Driver<FakeDriverContext>;
  runtime: FakeRuntime;
} {
  const runtime = new FakeRuntime(traits, options);

  const driver: Driver<FakeDriverContext> = {
    async sendEvent(_ctx, event, payload): Promise<SendResult> {
      const result = runtime.dispatch(_ctx.trait.traitName, event, payload);
      return { sent: true, serverResponse: result.serverResponse };
    },
    async getState(_ctx, traitName) {
      return runtime.getState(traitName);
    },
    async triggerDOM(ctx, step) {
      // FakeDriver has no DOM; route to sendEvent so the kernel still
      // covers the step.
      const result = runtime.dispatch(ctx.trait.traitName, step.event, step.payload as EventPayload);
      return result.to !== null;
    },
    async snapshot(_ctx, _step): Promise<SnapshotResult> {
      const drained = runtime.drain();
      return {
        runtimeSnapshot: runtime.snapshot(),
        dom: {
          url: 'fake://test',
          rowsByEntity: rowCounts(runtime.entityData()),
          portals: [],
          visibleTextSample: '',
        },
        consoleAdded: drained.consoleAdded,
        eventLogAdded: drained.eventLogAdded,
        effectResults: runtime.effectResults(),
        serverResponse: null,
        entityData: runtime.entityData(),
        screenshotPath: null,
      };
    },
    async reset(_ctx) {
      runtime.reset();
    },
    async settle(_ctx) {
      // No-op for the fake driver; everything is synchronous.
    },
  };

  return { driver, runtime };
}

function rowCounts(data: EntityData): { [name: string]: number } {
  const out: { [name: string]: number } = {};
  for (const [name, rows] of Object.entries(data)) {
    out[name] = rows.length;
  }
  return out;
}
