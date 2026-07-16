/**
 * `assertCrudFlow` — pure observer over `Frame[]` for the v3.7.0
 * CRUD-proof phase.
 *
 * For each frame whose `cause.testKind` is `crud-create` /
 * `crud-edit` / `crud-delete`, asserts THREE axes simultaneously, all
 * required for the verdict to pass:
 *
 *   1. **Emit event** —
 *      `frame.serverResponse?.emittedEvents.includes(cause.expectedSuccessEvent)`
 *      — the persist effect's declared `emit.success` landed on the
 *      cascade. Reuses VR2's signal.
 *   2. **Entity diff (with content match)** —
 *        - `crud-create`: `change.added.length === 1` AND every key in
 *          `cause.expectedRowContent` matches the added row's value
 *          (deep-equal per `FieldValue`).
 *        - `crud-edit`: `change.changed.length === 1` AND
 *          `change.changed[0].fieldsChanged` is a superset of
 *          `cause.expectedRowChangedFields`, AND the after-row's
 *          relevant fields match `cause.expectedRowContent`.
 *        - `crud-delete`: `change.removed.length === 1` AND, when
 *          `cause.targetRowId` is set, the removed row's id matches.
 *   3. **DOM list update** —
 *      `frame.domSnapshot.rowsByEntity[entityName]` changed by exactly
 *      `cause.expectedRowDelta.delta` from the previous frame's
 *      snapshot.
 *
 * Three-axis verdict: all three must pass, or the verdict is failed
 * with a per-axis breakdown in `detail`.
 *
 * Pure. No `Page`, no DOM, no runtime calls. Operates on the temporal
 * `Frame[]` stream alone.
 *
 * @packageDocumentation
 */

import type { EntityRow, FieldValue } from '@almadar/core';
import type { Frame, EntityChange } from '../frame/types.js';
import type { Verdict } from './types.js';

/**
 * Bound on the forward-scan window used to credit cascade landings.
 * persist→emit→listen→fetch sometimes settles AFTER the modal-trait
 * step's snapshot is captured, so Axis 2 (entity diff) and Axis 3 (DOM
 * count) can show no change on the step's own frame but DO show it 1-3
 * frames later when the cascading fetch's data has reduced into the
 * Browse trait. We cap the scan at MAX_CASCADE_LOOKAHEAD frames AND
 * stop at the next CRUD step or reconcile preamble — those boundaries
 * mark a new logical step, so anything past them belongs to a different
 * verdict.
 */
const MAX_CASCADE_LOOKAHEAD = 4;

/**
 * Storage tier the walk ran against. `'mock'` is the standalone
 * playground's MockPersistenceAdapter: the persist handler acks the
 * write but the next fetch regenerates a fresh collection of the same
 * size (documented runtime tiering — see Almadar_Verification_Runtime.md
 * §Tiering), so the entity-diff and DOM-delta axes can never observe the
 * mutation. Under `'mock'` those axes demote to a note when axis 1 (the
 * persist's success emit) proves the write path; the compiled path stays
 * `'strict'`.
 */
export type CrudStorageTier = 'strict' | 'mock';

type CrudTestKind = 'crud-create' | 'crud-edit' | 'crud-delete';

export function assertCrudFlow(
  frames: ReadonlyArray<Frame>,
  storageTier: CrudStorageTier = 'strict',
): Verdict[] {
  const verdicts: Verdict[] = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const testKind = frame.cause.testKind;
    if (
      testKind !== 'crud-create' &&
      testKind !== 'crud-edit' &&
      testKind !== 'crud-delete'
    ) {
      continue;
    }

    const expected = frame.cause.expectedRowDelta;
    const successEvent = frame.cause.expectedSuccessEvent;
    if (expected === undefined || successEvent === undefined) {
      verdicts.push({
        passed: false,
        detail: `${testKind}: frame ${frame.index} (${frame.cause.event}) missing expectedRowDelta or expectedSuccessEvent on cause — planner bug`,
        evidence: { frameIndices: [frame.index] },
      });
      continue;
    }

    const entityName = expected.entityName;

    // Axis 1 — emit event landed on server cascade. The CRUD-step frame's
    // own `serverResponse` is the modal trait's response (e.g. ListItemEdit
    // for crud-edit), not the persistor's. The persist op runs on a
    // separate cascading transition (e.g. ListItemPersistor.DO_UPDATE)
    // whose response carries the success emit. Scan the snapshot's
    // transitions for any response whose `emittedEvents` carries
    // `expectedSuccessEvent`; fall back to the frame's own serverResponse
    // for non-cascading test kinds. Source-tagged via the snapshot's
    // TransitionTrace[]; no heuristics on trait-name matching.
    const cascadeEvents = findServerEmitInSnapshot(frame, successEvent);
    const emittedOnServer = cascadeEvents !== null
      ? cascadeEvents
      : (frame.serverResponse?.emittedEvents ?? []);
    const emitOk = emittedOnServer.includes(successEvent);

    // Axis 2 — entity diff matches the expected per-kind shape +
    //          row content. Cascade-aware: when the immediate frame's
    //          entityChange is absent or doesn't match the per-kind
    //          shape, scan a bounded window of subsequent frames for
    //          the cascade landing. The persist's success emit (Axis 1)
    //          fires on a cascading transition whose follow-up fetch
    //          may settle 1-3 frames later; without forward-scanning,
    //          a healthy CRUD round-trip reads as `diff ✗`.
    const cascade = findCrudCascadeLanding(frames, i, entityName, testKind, expected.delta);
    const settledFrame = cascade?.frame ?? frame;
    const settledChange = cascade?.change
      ?? frame.entityChanges.find((c) => c.entityName === entityName);
    const diffResult = checkEntityDiff(testKind, frame, settledChange, expected.delta);

    // Axis 3 — DOM list count delta matches expected. Baseline is the
    // frame immediately before the CRUD step (the user's pre-action
    // view); the "after" reading comes from the same cascade-aware
    // settled frame Axis 2 used, so all three axes line up on the same
    // observed moment.
    const prevFrame = i > 0 ? frames[i - 1] : null;
    const domResult = checkDomListDelta(prevFrame, settledFrame, entityName, expected.delta);

    const allOk = emitOk && diffResult.ok && domResult.ok;
    const evidenceIndices = buildEvidenceIndices(prevFrame, frame, settledFrame);

    if (allOk) {
      verdicts.push({
        passed: true,
        detail: `${testKind}: ${entityName} ${frame.cause.event} — emit ✓ (${successEvent}), diff ✓ (${diffResult.detail}), dom ✓ (${domResult.detail})`,
        evidence: { frameIndices: evidenceIndices },
      });
      continue;
    }

    const axes: string[] = [];
    axes.push(emitOk
      ? `emit ✓ (${successEvent})`
      : `emit ✗ (expected '${successEvent}', cascade=[${emittedOnServer.join(', ')}])`,
    );
    axes.push(diffResult.ok
      ? `diff ✓ (${diffResult.detail})`
      : `diff ✗ (${diffResult.detail})`,
    );
    axes.push(domResult.ok
      ? `dom ✓ (${domResult.detail})`
      : `dom ✗ (${domResult.detail})`,
    );

    if (storageTier === 'mock' && emitOk) {
      // Mock storage regenerates each collection on the next fetch, so
      // the materialization axes are unobservable by construction; the
      // emit axis already proves the write path. Demote, don't fail.
      verdicts.push({
        passed: true,
        detail: `${testKind}: ${entityName} ${frame.cause.event} — ${axes.join(', ')} — diff/dom demoted under mock storage tier`,
        evidence: { frameIndices: evidenceIndices },
      });
      continue;
    }

    verdicts.push({
      passed: false,
      detail: `${testKind}: ${entityName} ${frame.cause.event} — ${axes.join(', ')}`,
      evidence: { frameIndices: evidenceIndices },
    });
  }

  return verdicts;
}

// ── internal ─────────────────────────────────────────────────────────

interface AxisResult {
  ok: boolean;
  detail: string;
}

interface CascadeLanding {
  frame: Frame;
  change: EntityChange;
}

/**
 * Scan `frame.runtimeSnapshot.transitions` for a `serverResponse.emittedEvents`
 * that includes `successEvent`. Returns the matching response's
 * `emittedEvents` array, or `null` if no transition in the snapshot
 * carries the event. Used by `assertCrudFlow` because the persist's
 * success emit lives on the persistor's transition, not on the modal
 * trait's frame-local `serverResponse`.
 */
function findServerEmitInSnapshot(
  frame: Frame,
  successEvent: string,
): readonly string[] | null {
  const transitions = frame.runtimeSnapshot.transitions;
  for (const tx of transitions) {
    const events = tx.serverResponse?.emittedEvents;
    if (events !== undefined && events.includes(successEvent)) {
      return events;
    }
  }
  return null;
}

/**
 * Search frames `[startIndex, startIndex+MAX_CASCADE_LOOKAHEAD]` for the
 * first frame whose `entityChanges` carries an `EntityChange` for
 * `entityName` whose shape matches the expected CRUD outcome. The
 * persist's success emit (Axis 1) cascades through Browse.listens → INIT →
 * fetch → re-render; the fetch can settle 1-3 frames after the modal
 * step's snapshot, so the per-kind diff may only appear on a later
 * frame. Returning the first matching frame lets Axis 2 + Axis 3
 * pick the same observation point and credit a healthy round-trip.
 *
 * Stops at the next CRUD step or the next `reconcile` preamble — those
 * boundaries mark a new logical step, so anything past them belongs to a
 * different verdict and would over-credit if scanned. Returns `null`
 * when no settled landing exists in the window, leaving the caller to
 * fall back to the immediate frame's (likely empty) entityChanges and
 * emit the existing `no entityChange recorded` failure.
 */
function findCrudCascadeLanding(
  frames: ReadonlyArray<Frame>,
  startIndex: number,
  entityName: string,
  testKind: CrudTestKind,
  expectedDelta: number,
): CascadeLanding | null {
  const limit = Math.min(frames.length, startIndex + MAX_CASCADE_LOOKAHEAD + 1);
  for (let j = startIndex; j < limit; j++) {
    const candidate = frames[j];
    if (j > startIndex) {
      const candTestKind = candidate.cause.testKind;
      if (
        candTestKind === 'crud-create' ||
        candTestKind === 'crud-edit' ||
        candTestKind === 'crud-delete'
      ) {
        break;
      }
      if (candidate.cause.triggerKind === 'reconcile') {
        break;
      }
    }
    const change = candidate.entityChanges.find((c) => c.entityName === entityName);
    if (change === undefined) continue;
    if (matchesCrudShape(testKind, change, expectedDelta)) {
      return { frame: candidate, change };
    }
  }
  return null;
}

/**
 * Whether `change` is the cascade-settled shape `testKind` expects. Used
 * by the forward-scan to decide which frame to credit; mirrors the
 * top-of-each-branch shape gate in `checkEntityDiff` so the two stay
 * consistent (content-mismatch verdicts still flow through
 * `checkEntityDiff` once the shape is locked).
 */
function matchesCrudShape(
  testKind: CrudTestKind,
  change: EntityChange,
  expectedDelta: number,
): boolean {
  if (testKind === 'crud-create') return change.added.length === 1;
  if (testKind === 'crud-edit') return change.changed.length === 1;
  if (change.removed.length !== 1) return false;
  return change.added.length - change.removed.length === expectedDelta;
}

/** Per-verdict evidence indices. Includes the baseline, the step's own frame, and (when distinct) the cascade-settled frame. */
function buildEvidenceIndices(
  prevFrame: Frame | null,
  stepFrame: Frame,
  settledFrame: Frame,
): number[] {
  const out: number[] = [];
  if (prevFrame !== null) out.push(prevFrame.index);
  out.push(stepFrame.index);
  if (settledFrame.index !== stepFrame.index) out.push(settledFrame.index);
  return out;
}

function checkEntityDiff(
  testKind: CrudTestKind,
  frame: Frame,
  change: Frame['entityChanges'][number] | undefined,
  expectedDelta: number,
): AxisResult {
  if (change === undefined) {
    return { ok: false, detail: `no entityChange recorded for entity` };
  }

  const expectedContent = frame.cause.expectedRowContent;

  if (testKind === 'crud-create') {
    if (change.added.length !== 1) {
      return {
        ok: false,
        detail: `expected 1 added row, got ${change.added.length}`,
      };
    }
    if (expectedContent !== undefined) {
      const mismatch = findContentMismatch(change.added[0], expectedContent);
      if (mismatch !== null) {
        return {
          ok: false,
          detail: `added row content mismatch on field '${mismatch.field}' (expected ${formatValue(mismatch.expected)}, got ${formatValue(mismatch.actual)})`,
        };
      }
      return {
        ok: true,
        detail: `added 1 row, content matches ${Object.keys(expectedContent).length} field(s)`,
      };
    }
    return { ok: true, detail: `added 1 row (no content assertion)` };
  }

  if (testKind === 'crud-edit') {
    if (change.changed.length !== 1) {
      return {
        ok: false,
        detail: `expected 1 changed row, got ${change.changed.length} (added=${change.added.length}, removed=${change.removed.length})`,
      };
    }
    const rowChange = change.changed[0];
    const expectedFields = frame.cause.expectedRowChangedFields ?? [];
    const fieldsChangedSet = new Set(rowChange.fieldsChanged);
    const missingFields = expectedFields.filter((f) => !fieldsChangedSet.has(f));
    if (missingFields.length > 0) {
      return {
        ok: false,
        detail: `expected fields ${expectedFields.join(', ')} to change; missing ${missingFields.join(', ')} (actual changed=${rowChange.fieldsChanged.join(', ')})`,
      };
    }
    if (expectedContent !== undefined) {
      const mismatch = findContentMismatch(rowChange.after, expectedContent);
      if (mismatch !== null) {
        return {
          ok: false,
          detail: `after-row content mismatch on field '${mismatch.field}' (expected ${formatValue(mismatch.expected)}, got ${formatValue(mismatch.actual)})`,
        };
      }
    }
    return {
      ok: true,
      detail: `1 row changed, fields=${rowChange.fieldsChanged.join(', ')}`,
    };
  }

  // crud-delete
  if (change.removed.length !== 1) {
    return {
      ok: false,
      detail: `expected 1 removed row, got ${change.removed.length}`,
    };
  }
  const targetRowId = frame.cause.targetRowId;
  if (targetRowId !== undefined && String(change.removed[0].id) !== targetRowId) {
    return {
      ok: false,
      detail: `removed row id mismatch (expected ${targetRowId}, got ${String(change.removed[0].id)})`,
    };
  }
  // expectedRowDelta sanity check.
  const actualDelta = change.added.length - change.removed.length;
  if (actualDelta !== expectedDelta) {
    return {
      ok: false,
      detail: `delta ${signDelta(actualDelta)} did not match expected ${signDelta(expectedDelta)}`,
    };
  }
  return { ok: true, detail: `removed 1 row` };
}

function checkDomListDelta(
  prevFrame: Frame | null,
  frame: Frame,
  entityName: string,
  expectedDelta: number,
): AxisResult {
  const after = frame.domSnapshot.rowsByEntity[entityName];
  if (after === undefined) {
    return {
      ok: false,
      detail: `domSnapshot.rowsByEntity has no entry for '${entityName}'`,
    };
  }
  if (prevFrame === null) {
    // First frame — DOM count matches the absolute delta from 0.
    if (after !== Math.max(0, expectedDelta)) {
      return {
        ok: false,
        detail: `first-frame dom count for '${entityName}' = ${after}, expected ${Math.max(0, expectedDelta)}`,
      };
    }
    return { ok: true, detail: `dom rows for '${entityName}' = ${after}` };
  }
  const before = prevFrame.domSnapshot.rowsByEntity[entityName] ?? 0;
  const actualDelta = after - before;
  if (actualDelta !== expectedDelta) {
    return {
      ok: false,
      detail: `dom rows for '${entityName}' went ${before}→${after} (delta ${signDelta(actualDelta)}, expected ${signDelta(expectedDelta)})`,
    };
  }
  return {
    ok: true,
    detail: `dom rows for '${entityName}' ${before}→${after} (${signDelta(actualDelta)})`,
  };
}

interface ContentMismatch {
  field: string;
  expected: FieldValue;
  actual: FieldValue | undefined;
}

function findContentMismatch(
  row: EntityRow,
  expected: Record<string, FieldValue>,
): ContentMismatch | null {
  for (const [field, expectedValue] of Object.entries(expected)) {
    const actualValue = row[field];
    if (!fieldValueEquals(actualValue, expectedValue)) {
      return { field, expected: expectedValue, actual: actualValue };
    }
  }
  return null;
}

/**
 * Structural equality for core's `FieldValue` union (string | number |
 * boolean | Date | null | array | record). Date compares by
 * `.getTime()`; arrays + records compare element-wise + key-wise;
 * primitives via `===`.
 */
function fieldValueEquals(a: FieldValue | undefined, b: FieldValue): boolean {
  if (a === undefined) return b === null;
  if (a === null && b === null) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!fieldValueEquals(a[i], b[i])) return false;
    }
    return true;
  }
  if (
    typeof a === 'object' && a !== null && !(a instanceof Date) && !Array.isArray(a) &&
    typeof b === 'object' && b !== null && !(b instanceof Date) && !Array.isArray(b)
  ) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!fieldValueEquals((a as Record<string, FieldValue>)[k], (b as Record<string, FieldValue>)[k])) return false;
    }
    return true;
  }
  return a === b;
}

function formatValue(v: FieldValue | undefined): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (v instanceof Date) return `Date(${v.toISOString()})`;
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function signDelta(d: number): string {
  if (d > 0) return `+${d}`;
  if (d < 0) return `${d}`;
  return '0';
}
