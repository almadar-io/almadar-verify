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
 *      - `tick`: no dispatch — wait `step.waitMs` so the runtime's tick
 *        scheduler fires, then observe.
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

import type { EventPayload, ServerResponseTrace } from '@almadar/core';
import { makeInitFrame, makeWalkFrame } from '../frame/factory.js';
import type { Frame, FrameCause } from '../frame/types.js';
import type { ExtendedWalkStep } from '../planner/types.js';
import type { Driver, DriverContext } from './types.js';

export async function tick<Ctx extends DriverContext>(
  driver: Driver<Ctx>,
  ctx: Ctx,
  prev: Frame | null,
  step: ExtendedWalkStep,
  orbitalsByTrait?: ReadonlyMap<string, string>,
  allowStateless?: boolean,
): Promise<Frame> {
  const index = prev === null ? 0 : prev.index + 1;
  const timestamp = Date.now();
  // Gap #13: qualified `${orbital}.${trait}` scope under which the
  // dispatching trait subscribes (codegen emits `useUIEvents(_, scope, ...)`).
  // The bridge concatenates `UI:${scope}.${event}` to match the trait's
  // own subscription. Lookup uses the schema's `orbitals[].traits[]`
  // mapping the caller built from `input.orbital`. Undefined when the
  // trait isn't found; the bridge falls back to bare `UI:${event}`.
  const orbitalName = orbitalsByTrait?.get(step.traitName);
  const traitScope =
    orbitalName !== undefined ? `${orbitalName}.${step.traitName}` : undefined;

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
    ...(step.guardSteerable !== undefined && { guardSteerable: step.guardSteerable }),
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
  let domFellBackToBus = false;
  // `dispatchSent` tracks whether the driver actually dispatched the
  // event. The DOM-trigger path that finds an affordance and clicks it
  // counts as sent; otherwise it falls through to `sendEvent` and we
  // capture `send.sent`. A `false` here means the kernel failed to
  // deliver the event at all — the frame must fail closed.
  let dispatchSent: boolean;

  if (step.triggerKind === 'tick') {
    // Tick-wait step (planTickTests): nothing to dispatch. Wait out the
    // declared interval so the runtime's own tick scheduler fires, then
    // fall through to settle + snapshot. `dispatchSent` stays true —
    // there is no delivery to fail closed on.
    if (step.waitMs !== undefined && step.waitMs > 0) {
      await new Promise((resolve) => { setTimeout(resolve, step.waitMs); });
    }
    dispatchSent = true;
  } else if (step.triggerKind === 'dom') {
    const triggered = await driver.triggerDOM(ctx, step, traitScope);
    if (triggered) {
      dispatchSent = true;
    } else {
      // No affordance was visible/clickable in this context — the frame
      // must record the EFFECTIVE trigger ('bus'), not the planned one:
      // click observers (click-path, click-no-listener) judge DOM truth
      // and a fallback dispatch is not a click.
      domFellBackToBus = true;
      const send = await driver.sendEvent(ctx, step.event, asEventPayload(step.payload), traitScope);
      serverResponse = send.serverResponse;
      dispatchSent = send.sent;
    }
  } else {
    // 'bus' | 'replay' | 'reconcile' — all dispatch via the bus.
    // `reconcile` frames are kernel-injected preamble steps walking the
    // trait from its initial state to the next planner step's `from`;
    // semantically identical to `replay` for dispatch purposes.
    const send = await driver.sendEvent(ctx, step.event, asEventPayload(step.payload), traitScope);
    serverResponse = send.serverResponse;
    dispatchSent = send.sent;
  }

  await driver.settle(ctx);
  const stateAfter = await driver.getState(ctx, step.traitName);
  const snap = await driver.snapshot(ctx, step);

  const effectiveServerResponse = serverResponse ?? snap.serverResponse;
  const errors = collectDispatchErrors(step, stateAfter, dispatchSent, allowStateless === true);
  const accepted = errors.length === 0 && decideAccepted(step, stateBefore, stateAfter, effectiveServerResponse);

  return makeWalkFrame({
    ...(errors.length > 0 && { errors }),
    index,
    timestamp,
    cause: domFellBackToBus ? { ...cause, triggerKind: 'bus' } : cause,
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
 * Collect fail-closed dispatch errors for a frame. The kernel must NOT
 * silently credit a step the driver couldn't deliver, nor a stateless
 * dispatch (`getState` returned `null`) unless the caller opted in via
 * `allowStateless` (drivers with no state reader). Returns one error
 * string per failure; an empty array means the dispatch was clean.
 */
function collectDispatchErrors(
  step: ExtendedWalkStep,
  stateAfter: string | null,
  dispatchSent: boolean,
  allowStateless: boolean,
): string[] {
  const errors: string[] = [];
  if (!dispatchSent) {
    errors.push(
      `dispatch failed: driver did not deliver event '${step.event}' to trait '${step.traitName}'`,
    );
  }
  // A navigate-carrying transition can swap the page and unmount the trait
  // before the state read — a null read there is the navigation working,
  // not a stateless dispatch.
  if (stateAfter === null && !allowStateless && step.navigates !== true) {
    errors.push(
      `stateless dispatch: getState returned null after event '${step.event}' on trait '${step.traitName}' (pass allowStateless to credit drivers with no state reader)`,
    );
  }
  return errors;
}

/**
 * Decide whether the runtime accepted the transition. Mirrors the
 * legacy engine's logic. Fail-closed: a `null` `stateAfter` is no longer
 * optimistically credited here — that path is gated by `allowStateless`
 * in `collectDispatchErrors`, which already short-circuits acceptance.
 */
function decideAccepted(
  step: ExtendedWalkStep,
  stateBefore: string | null,
  stateAfter: string | null,
  serverResponse: ServerResponseTrace | null,
): boolean {
  if (step.guardCase === 'fail') {
    // Guard-fail: state should NOT change — unless a complementary sibling
    // arm of the same (from, event) caught the failing payload, which is
    // the state machine working (planner-supplied guardSiblingTargets).
    return (
      stateAfter === step.from ||
      stateAfter === stateBefore ||
      (stateAfter !== null && (step.guardSiblingTargets ?? []).includes(stateAfter))
    );
  }
  if (step.payloadCase === 'malformed') {
    // Malformed: the API-boundary validator must REJECT the empty/bad
    // payload, so the state machine must NOT advance to `step.to`. When
    // the path is server-authoritative we also require the server to have
    // actually rejected — a `success:true` that happened to leave state
    // unchanged would mean the validator silently accepted bad input (a
    // real gap), which must stay flagged. On the runtime/interpreter path
    // there is no `serverResponse`; state-held alone is the contract.
    const held = stateAfter === step.from || stateAfter === stateBefore;
    const serverRejected = serverResponse === null || serverResponse.success === false;
    return held && serverRejected;
  }
  // Normal or guard-pass: state should reach step.to — or any state in the
  // transient closure when `to` auto-advances (planner-supplied acceptStates,
  // e.g. `loading` settling at `browsing` after its fetch). A `null`
  // `stateAfter` only reaches here when `allowStateless` was set (else
  // `collectDispatchErrors` already forced `accepted = false`), so we credit
  // it as the caller-opted stateless-driver case.
  if (stateAfter === null) return true;
  const accepted = step.acceptStates ?? [step.to];
  return accepted.includes(stateAfter);
}
