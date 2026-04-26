/**
 * Frame factory + temporal diff helpers.
 *
 * Pure functions only. Given a previous Frame (or null) and the raw
 * observation produced by the driver's `snapshot()` call, produce the
 * next immutable Frame. The diff helpers (`diffConsole`, `diffEventLog`,
 * `diffEntities`) compute the per-step deltas observers consume.
 *
 * @packageDocumentation
 */

import type {
  EntityData,
  EntityRow,
  EventLogEntry,
  EventPayload,
  FieldValue,
  VerificationSnapshot,
} from '@almadar/core';
import type { ConsoleEntry } from '../util/types.js';
import type {
  ConsoleDelta,
  EntityChange,
  EntityRowChange,
  EventLogDelta,
  Frame,
  FrameCause,
} from './types.js';

/**
 * Stable key for a frame's cause. Format:
 *   `${trait}:${from}+${event}->${to}` (unguarded)
 *   `${trait}:${from}+${event}->${to}[pass|fail]` (guarded)
 *
 * Single source of truth for coverage keys. `coverage()` numerator =
 * deduped `frames.map(f => keyOf(f.cause))`; denominator = same scheme
 * applied to the `ExtendedWalkStep[]` plan.
 */
export function keyOf(cause: FrameCause): string {
  const base = `${cause.traitName}:${cause.from}+${cause.event}->${cause.to}`;
  if (cause.guardCase === null) return base;
  return `${base}[${cause.guardCase}]`;
}

/**
 * Diff two console buffers chronologically. The driver hands back only
 * entries newer than the previous capture; we re-count error/warning
 * tallies for the observer's convenience.
 */
export function diffConsole(added: ReadonlyArray<ConsoleEntry>): ConsoleDelta {
  let newErrors = 0;
  let newWarnings = 0;
  for (const entry of added) {
    if (entry.type === 'error') newErrors += 1;
    else if (entry.type === 'warning') newWarnings += 1;
  }
  return { added, newErrors, newWarnings };
}

/** Diff two bus event logs. The driver supplies only the new tail. */
export function diffEventLog(added: ReadonlyArray<EventLogEntry>): EventLogDelta {
  return { added };
}

/**
 * Compute per-entity changes between two `EntityData` snapshots. Diffs
 * each entity's `EntityRow[]` by id:
 *  - `added`: rows whose id is in `after` but not in `before`
 *  - `removed`: rows whose id is in `before` but not in `after`
 *  - `changed`: rows present in both whose `FieldValue`s differ
 *
 * Rows without an `id` field are skipped from add/remove/changed
 * diffing (no stable identity), but still flow through `before`/`after`.
 */
export function diffEntities(
  before: EntityData,
  after: EntityData,
): ReadonlyArray<EntityChange> {
  const entityNames = new Set<string>([
    ...Object.keys(before),
    ...Object.keys(after),
  ]);
  const result: EntityChange[] = [];

  for (const entityName of entityNames) {
    const beforeRows = before[entityName] ?? [];
    const afterRows = after[entityName] ?? [];

    const beforeById = new Map<string, EntityRow>();
    for (const row of beforeRows) {
      if (typeof row.id === 'string') beforeById.set(row.id, row);
    }
    const afterById = new Map<string, EntityRow>();
    for (const row of afterRows) {
      if (typeof row.id === 'string') afterById.set(row.id, row);
    }

    const added: EntityRow[] = [];
    const removed: EntityRow[] = [];
    const changed: EntityRowChange[] = [];

    for (const [id, row] of afterById) {
      if (!beforeById.has(id)) added.push(row);
    }
    for (const [id, row] of beforeById) {
      if (!afterById.has(id)) removed.push(row);
    }
    for (const [id, beforeRow] of beforeById) {
      const afterRow = afterById.get(id);
      if (afterRow === undefined) continue;
      const fieldsChanged = diffRowFields(beforeRow, afterRow);
      if (fieldsChanged.length > 0) {
        changed.push({ id, before: beforeRow, after: afterRow, fieldsChanged });
      }
    }

    result.push({
      entityName,
      before: beforeRows,
      after: afterRows,
      added,
      removed,
      changed,
    });
  }

  return result;
}

/** Inputs `tick()` hands the factory after a successful step. */
export interface MakeFrameInput {
  index: number;
  timestamp: number;
  cause: FrameCause;
  stateBefore: string | null;
  stateAfter: string | null;
  payload: EventPayload;
  runtimeSnapshot: VerificationSnapshot;
  domSnapshot: Frame['domSnapshot'];
  consoleAdded: ReadonlyArray<ConsoleEntry>;
  eventLogAdded: ReadonlyArray<EventLogEntry>;
  entitiesBefore: EntityData;
  entitiesAfter: EntityData;
  effectResults: Frame['effectResults'];
  serverResponse: Frame['serverResponse'];
  screenshotPath: string | null;
  accepted: boolean;
  errors?: ReadonlyArray<string>;
  warnings?: ReadonlyArray<string>;
}

/**
 * Build a normal walk Frame. Computes deltas internally so callers don't
 * have to.
 */
export function makeWalkFrame(input: MakeFrameInput): Frame {
  return {
    index: input.index,
    timestamp: input.timestamp,
    cause: input.cause,
    stateBefore: input.stateBefore,
    stateAfter: input.stateAfter,
    payload: input.payload,
    eventFired: input.cause.event,
    runtimeSnapshot: input.runtimeSnapshot,
    domSnapshot: input.domSnapshot,
    consoleDelta: diffConsole(input.consoleAdded),
    eventLogDelta: diffEventLog(input.eventLogAdded),
    entityChanges: diffEntities(input.entitiesBefore, input.entitiesAfter),
    effectResults: input.effectResults,
    serverResponse: input.serverResponse,
    screenshotPath: input.screenshotPath,
    accepted: input.accepted,
    errors: input.errors ?? [],
    warnings: input.warnings ?? [],
  };
}

/** Inputs for the synthetic auto-init Frame the kernel prepends per trait. */
export interface MakeInitFrameInput {
  index: number;
  timestamp: number;
  traitName: string;
  initialState: string;
  runtimeSnapshot: VerificationSnapshot;
  domSnapshot: Frame['domSnapshot'];
  consoleAdded: ReadonlyArray<ConsoleEntry>;
  eventLogAdded: ReadonlyArray<EventLogEntry>;
  entitiesAfter: EntityData;
  screenshotPath: string | null;
}

/**
 * Build the synthetic auto-init Frame. The runtime auto-fires INIT from
 * the initial state on mount, so this Frame represents that boot moment:
 * `cause.event === 'INIT'`, `triggerKind === 'auto-init'`, and the state
 * machine is already at `initialState`. No `sendEvent` was needed.
 *
 * `entitiesBefore` is treated as empty since this is the first frame in
 * the trait's stream — every entity row already in `entitiesAfter` is
 * an `added` row from the verifier's perspective. (The pre-walk reset
 * in the driver clears persistence so this is accurate.)
 */
export function makeInitFrame(input: MakeInitFrameInput): Frame {
  const cause: FrameCause = {
    traitName: input.traitName,
    from: input.initialState,
    event: 'INIT',
    to: input.initialState,
    guardCase: null,
    triggerKind: 'auto-init',
    isRepositioning: false,
  };
  return makeWalkFrame({
    index: input.index,
    timestamp: input.timestamp,
    cause,
    stateBefore: null,
    stateAfter: input.initialState,
    payload: {},
    runtimeSnapshot: input.runtimeSnapshot,
    domSnapshot: input.domSnapshot,
    consoleAdded: input.consoleAdded,
    eventLogAdded: input.eventLogAdded,
    entitiesBefore: {},
    entitiesAfter: input.entitiesAfter,
    effectResults: [],
    serverResponse: null,
    screenshotPath: input.screenshotPath,
    accepted: true,
  });
}

// ── internal ─────────────────────────────────────────────────────────

/**
 * Compare two `EntityRow`s field-by-field. Returns the keys whose
 * `FieldValue` differs structurally. Ignores keys present on only one
 * side (those are handled by `added`/`removed` at the row level — they
 * shouldn't co-occur with `changed` for the same id, so we report all
 * field keys from the union).
 */
function diffRowFields(before: EntityRow, after: EntityRow): string[] {
  const keys = new Set<string>([
    ...Object.keys(before),
    ...Object.keys(after),
  ]);
  const changed: string[] = [];
  for (const key of keys) {
    if (key === 'id') continue;
    if (!fieldValueEquals(before[key], after[key])) changed.push(key);
  }
  return changed;
}

/**
 * Structural equality for `FieldValue`. Handles primitives, Date,
 * arrays (recursive), and plain object maps (recursive). Mirrors
 * `FieldValue` shape from `@almadar/core`.
 */
function fieldValueEquals(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!fieldValueEquals(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      const av = (a as { [k: string]: FieldValue | undefined })[key];
      const bv = (b as { [k: string]: FieldValue | undefined })[key];
      if (!fieldValueEquals(av, bv)) return false;
    }
    return true;
  }
  return false;
}
