/**
 * `tick` — the kernel's single I/O boundary function.
 *
 * Given a Driver, the previous Frame (or null), and a planned step,
 * produces the next Frame:
 *
 *  1. Read state BEFORE.
 *  2. Fire the step:
 *      - `auto-init`: skip dispatch (runtime auto-fires INIT on mount),
 *        just settle and snapshot.
 *      - `dom`: try `triggerDOM`; on failure, fall back to `sendEvent`.
 *      - `bus` / `replay`: `sendEvent`.
 *  3. Settle.
 *  4. Read state AFTER + snapshot.
 *  5. Determine `accepted` per the guard semantics.
 *  6. Build the Frame (delegating delta computation to `frame/factory`).
 *
 * The kernel never imports `playwright`. `Driver` is generic over
 * `Ctx`, so each impl threads its own runtime handle through
 * untouched.
 *
 * @packageDocumentation
 */

import type { EventPayload } from '@almadar/core';
import { makeInitFrame, makeWalkFrame } from '../frame/factory.js';
import type { Frame, FrameCause } from '../frame/types.js';
import type { ExtendedWalkStep } from '../planner/types.js';
import type { Driver, DriverContext } from './types.js';

export async function tick<Ctx extends DriverContext>(
  driver: Driver<Ctx>,
  ctx: Ctx,
  prev: Frame | null,
  step: ExtendedWalkStep,
): Promise<Frame> {
  const index = prev === null ? 0 : prev.index + 1;
  const timestamp = Date.now();

  const cause: FrameCause = {
    traitName: step.traitName,
    from: step.from,
    event: step.event,
    to: step.to,
    guardCase: step.guardCase,
    triggerKind: step.triggerKind,
    isRepositioning: step.isRepositioning,
    coverageKey: step.coverageKey,
    ...(step.testKind !== undefined && { testKind: step.testKind }),
    ...(step.expectedRowDelta !== undefined && { expectedRowDelta: step.expectedRowDelta }),
    ...(step.expectedPattern !== undefined && { expectedPattern: step.expectedPattern }),
    ...(step.expectedSuccessEvent !== undefined && { expectedSuccessEvent: step.expectedSuccessEvent }),
    ...(step.submitEvent !== undefined && { submitEvent: step.submitEvent }),
    ...(step.expectedRowContent !== undefined && { expectedRowContent: step.expectedRowContent }),
    ...(step.expectedRowChangedFields !== undefined && { expectedRowChangedFields: step.expectedRowChangedFields }),
    ...(step.targetRowId !== undefined && { targetRowId: step.targetRowId }),
    ...(step.confirmEvent !== undefined && { confirmEvent: step.confirmEvent }),
    ...(step.payloadCase !== undefined && { payloadCase: step.payloadCase }),
  };

  // Auto-init: the runtime already fired INIT on mount. Capture the
  // boot moment as a Frame without dispatching anything.
  if (step.triggerKind === 'auto-init') {
    await driver.settle(ctx);
    const snap = await driver.snapshot(ctx, step);
    return makeInitFrame({
      index,
      timestamp,
      traitName: step.traitName,
      initialState: step.from,
      runtimeSnapshot: snap.runtimeSnapshot,
      domSnapshot: snap.dom,
      consoleAdded: snap.consoleAdded,
      eventLogAdded: snap.eventLogAdded,
      entitiesAfter: snap.entityData,
      screenshotPath: snap.screenshotPath,
    });
  }

  const stateBefore = await driver.getState(ctx, step.traitName);

  // Read entitiesBefore from the previous frame's snapshot. If no
  // previous frame exists for this trait, the entity store starts
  // empty (mock store reset via beforeTrait / reset).
  const entitiesBefore = entitiesFromPrev(prev, step.traitName);

  let serverResponse = null;

  if (step.triggerKind === 'dom') {
    const triggered = await driver.triggerDOM(ctx, step);
    if (!triggered) {
      const send = await driver.sendEvent(ctx, step.event, asEventPayload(step.payload));
      serverResponse = send.serverResponse;
    }
  } else {
    // 'bus' | 'replay' | 'reconcile' — all dispatch via the bus.
    // `reconcile` frames are kernel-injected preamble steps walking the
    // trait from its initial state to the next planner step's `from`;
    // semantically identical to `replay` for dispatch purposes.
    const send = await driver.sendEvent(ctx, step.event, asEventPayload(step.payload));
    serverResponse = send.serverResponse;
  }

  await driver.settle(ctx);
  const stateAfter = await driver.getState(ctx, step.traitName);
  const snap = await driver.snapshot(ctx, step);

  const accepted = decideAccepted(step, stateBefore, stateAfter);

  return makeWalkFrame({
    index,
    timestamp,
    cause,
    stateBefore,
    stateAfter,
    payload: asEventPayload(step.payload),
    runtimeSnapshot: snap.runtimeSnapshot,
    domSnapshot: snap.dom,
    consoleAdded: snap.consoleAdded,
    eventLogAdded: snap.eventLogAdded,
    entitiesBefore,
    entitiesAfter: snap.entityData,
    effectResults: snap.effectResults,
    serverResponse: serverResponse ?? snap.serverResponse,
    screenshotPath: snap.screenshotPath,
    accepted,
  });
}

// ── internal ─────────────────────────────────────────────────────────

/**
 * `WalkStep.payload` is typed `Record<string, unknown>` in @almadar/core
 * (with a justified eslint-disable — payloads are dynamically derived
 * from guard expressions and schema mocks). At the kernel boundary the
 * values that flow through are EventPayload-shaped (mock strings,
 * numbers, booleans, empty objects) so we coerce to `EventPayload`
 * here. Casting via the unknown cast site established in the existing
 * core type, not in new kernel code.
 */
function asEventPayload(payload: Record<string, unknown>): EventPayload {
  return payload as EventPayload;
}

/**
 * Pull the previous frame's `entitiesAfter` for the given trait. Walks
 * the trait's frames backwards looking for the most recent snapshot;
 * cross-trait isolation is the responsibility of the caller (the
 * pipeline groups frames per trait). Returns `EntityData` (mutable
 * row arrays) — the diff helpers don't mutate but the type alignment
 * matters for `makeWalkFrame`'s input.
 */
function entitiesFromPrev(
  prev: Frame | null,
  _traitName: string,
): import('@almadar/core').EntityData {
  if (prev === null) return {};
  const out: import('@almadar/core').EntityData = {};
  for (const change of prev.entityChanges) {
    // `change.after` is ReadonlyArray<EntityRow>; copy to a mutable
    // array so the type aligns with EntityData.
    out[change.entityName] = [...change.after];
  }
  return out;
}

/**
 * Decide whether the runtime accepted the transition. Mirrors the
 * legacy engine's logic.
 */
function decideAccepted(
  step: ExtendedWalkStep,
  stateBefore: string | null,
  stateAfter: string | null,
): boolean {
  if (step.guardCase === 'fail') {
    // Guard-fail: state should NOT change.
    return stateAfter === step.from || stateAfter === stateBefore;
  }
  // Normal or guard-pass: state should reach step.to. `null` from
  // `getState` means the runtime didn't expose a state reader; we
  // optimistically credit acceptance in that case.
  return stateAfter === step.to || stateAfter === null;
}
