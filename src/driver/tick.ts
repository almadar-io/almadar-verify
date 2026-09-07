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

import type { EntityData, EntityRow, EventPayload, FieldValue, RawUserClaims, ServerResponseTrace } from '@almadar/core';
import { collectBindings } from '@almadar/core';
import { createMinimalContext, evaluateGuard } from '@almadar/evaluator';
import { makeInitFrame, makeWalkFrame } from '../frame/factory.js';
import type { Frame, FrameCause } from '../frame/types.js';
import type { ExtendedWalkStep } from '../planner/types.js';
import type { ViewerRequirement } from '../planner/internal/viewer-requirement.js';
import { pickTargetRow } from '../planner/internal/self-relation-fields.js';
import type { Driver, DriverContext } from './types.js';

export async function tick<Ctx extends DriverContext>(
  driver: Driver<Ctx>,
  ctx: Ctx,
  prev: Frame | null,
  step: ExtendedWalkStep,
  orbitalsByTrait?: ReadonlyMap<string, string>,
  allowStateless?: boolean,
  // C1-V9 item A: the app's own default persona, read ONCE by
  // `runVerification` before the trait's step loop (`driver.getPersona`)
  // so a `viewerRequirement`-bearing step can switch away from it and
  // restore exactly this value afterward — never a bare `undefined`/`{}`,
  // which would strand every later step under an anonymous viewer.
  defaultPersona?: RawUserClaims | null,
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

  // C1-V12 (rung 3): `entitiesBefore` is the BROWSER's previous-frame
  // snapshot — a filtered/paged SUBSET of the runtime's actual mock
  // store (a trait's fetched `data`). Row-picking off it alone can judge
  // a row "safe to delete" when a sibling the page never rendered
  // references it, or vice versa. When the driver can report the FULL
  // store (`listEntityRows`), prefer it for referential-safety checks;
  // absent it, fall back to `entitiesBefore` — reproducing the
  // pre-existing (browser-only) behavior exactly.
  const serverRowsFor = async (entityName: string): Promise<ReadonlyArray<EntityRow>> => {
    if (driver.listEntityRows === undefined) return entitiesBefore[entityName] ?? [];
    try {
      return await driver.listEntityRows(ctx, entityName);
    } catch {
      // Endpoint missing / transient failure — fall back rather than
      // fail the whole step closed over a tooling hiccup.
      return entitiesBefore[entityName] ?? [];
    }
  };

  // C1-V8 (R-PERSIST-NO-ROW-KEY-SILENT-SUCCESS, the `from === initialState`
  // gap): the planner statically determined this update/delete step's
  // target row can never exist before it fires — never a silent bus
  // dispatch, never a pass. May also be set dynamically below when a
  // `bindRowFrom` preamble finds no seeded row at dispatch time.
  let unreachableRow: string | undefined = step.unreachableRowReason;

  // C1-V9 item B follow-on: pick the self-binding target row ONCE, up
  // front — item A's ownership derivation and item B's own payload fill
  // (below) MUST agree on the same row. Deriving the viewer from row 0's
  // owner while `avoidReferencedVia` picks a DIFFERENT row for the actual
  // dispatch would switch to a viewer that doesn't own the row actually
  // being written.
  //
  // C1-V12 item 3: this dispatch is bus-driven (a preamble's payload
  // carries the row directly — nothing needs to be clicked), so the pick
  // draws from the SERVER-truth set with no visibility requirement: a
  // page with ZERO visible rows of the entity still resolves a real
  // target instead of the old "no row key" failure.
  const bindRowResult = step.bindRowFrom !== undefined
    ? pickTargetRow(
        await serverRowsFor(step.bindRowFrom.entityName),
        entitiesBefore[step.bindRowFrom.entityName] ?? [],
        step.bindRowFrom.avoidReferencedVia,
      )
    : undefined;
  const boundRow = bindRowResult !== undefined && 'row' in bindRowResult ? bindRowResult.row : undefined;
  const boundRowReason = bindRowResult !== undefined && 'reason' in bindRowResult ? bindRowResult.reason : undefined;

  // C1-V11: `planUserCrudFlow`'s crud-edit/crud-delete steps leave
  // `targetRowId` undefined so the DOM trigger's default ("first
  // `[data-row-id]` affordance") applies — but for a self-referential
  // entity that default row is a ROOT with children EVERY time (the mock
  // seeder's tree shape), which an `onDelete: restrict` rule rejects
  // regardless of viewer. Resolve the actual target row ONCE here, before
  // dispatch, so it drives the DOM click (`step.targetRowId` below), the
  // viewer switch (`rowOverride` below), and the persist payload (below)
  // — one row, one source of truth. `avoidReferencedVia` is only ever set
  // on `crud-delete` (edit needs SOME owned row, not an unreferenced
  // one), so `requireUnreferenced` only activates there; a `crud-edit`
  // step (or a delete on a non-self-referential entity) still falls back
  // to the structurally-first row exactly like before this item.
  //
  // C1-V12 item 2: this dispatch is DOM-driven (the DOM trigger clicks
  // `[data-row-id="<id>"]`), so the pick REQUIRES the row to be one the
  // current page actually rendered (`requireVisible: true`) — the
  // referential-safety check underneath still runs against the FULL
  // server-truth set, so a hidden sibling this page never rendered still
  // correctly blocks a visible candidate it references.
  const crudEntityName =
    (step.testKind === 'crud-edit' || step.testKind === 'crud-delete') && step.targetRowId === undefined
      ? step.expectedRowDelta?.entityName
      : undefined;
  let crudTargetRow: EntityRow | undefined;
  if (crudEntityName !== undefined && unreachableRow === undefined) {
    const avoidReferencedVia = step.avoidReferencedVia;
    const requireUnreferenced = avoidReferencedVia !== undefined && avoidReferencedVia.length > 0;
    // C1-V15 item B: a DOM-driven crud-edit/crud-delete step must target a
    // row whose affordance is actually ENABLED — a row for which the
    // affordance's own `disabled` expression evaluates `true` is a
    // structural no-op click (DOM ✓, cascade ✗), not a real candidate.
    const affordanceFilter = step.affordanceDisabledExpr !== undefined
      ? buildAffordanceEnabledFilter(step.affordanceDisabledExpr, step.event, stateBefore)
      : undefined;
    const crudRowResult = pickTargetRow(
      await serverRowsFor(crudEntityName),
      entitiesBefore[crudEntityName] ?? [],
      avoidReferencedVia,
      {
        requireUnreferenced,
        requireVisible: true,
        ...(affordanceFilter !== undefined && {
          isEnabled: affordanceFilter.isEnabled,
          disabledReason: affordanceFilter.disabledReason,
        }),
      },
    );
    if ('reason' in crudRowResult) {
      // C1-V15 item C: the current seed has no deletable row — when the
      // orbital's own `create` flow can establish one (planner-attached
      // ONLY for entities whose self-relation can legitimately run out of
      // headroom), dispatch it directly against the persistor (bus-fired,
      // bypassing its own DOM/form-fill proof — a SEPARATE crud-create
      // step in this same walk already proves that) and retry the pick
      // ONCE against the post-create server truth. The freshly-created row
      // is unreferenced by construction, so no special-casing is needed
      // beyond asking the store again.
      const fallback = step.deleteEstablishFallback;
      if (fallback !== undefined) {
        const fallbackTraitScope = (() => {
          const fallbackOrbital = orbitalsByTrait?.get(fallback.traitName);
          return fallbackOrbital !== undefined ? `${fallbackOrbital}.${fallback.traitName}` : undefined;
        })();
        let fallbackPersonaSwitched = false;
        if (fallback.viewerRequirement !== undefined && driver.setPersona !== undefined) {
          const resolvedFallbackViewer = resolveViewerRequirement(fallback.viewerRequirement, entitiesBefore, defaultPersona, undefined);
          if (!('error' in resolvedFallbackViewer)) {
            await driver.setPersona(ctx, resolvedFallbackViewer.persona);
            fallbackPersonaSwitched = true;
          }
        }
        await driver.sendEvent(ctx, fallback.event, asEventPayload(fallback.payload), fallbackTraitScope);
        await driver.settle(ctx);
        if (fallbackPersonaSwitched && driver.setPersona !== undefined) {
          await driver.setPersona(ctx, defaultPersona ?? null);
        }
        const retryVisibleRows = (await driver.snapshot(ctx, null)).entityData[crudEntityName] ?? [];
        const retryResult = pickTargetRow(
          await serverRowsFor(crudEntityName),
          retryVisibleRows,
          avoidReferencedVia,
          {
            requireUnreferenced,
            requireVisible: true,
            ...(affordanceFilter !== undefined && {
              isEnabled: affordanceFilter.isEnabled,
              disabledReason: affordanceFilter.disabledReason,
            }),
          },
        );
        if ('reason' in retryResult) {
          unreachableRow =
            `no-target-row: '${crudEntityName}' has no row available for trait '${step.traitName}' — ${retryResult.reason} ` +
            `(after dispatching the declared create flow '${fallback.event}' as a fallback)`;
        } else {
          crudTargetRow = retryResult.row;
        }
      } else {
        unreachableRow =
          `no-target-row: '${crudEntityName}' has no row available for trait '${step.traitName}' — ${crudRowResult.reason}`;
      }
    } else {
      crudTargetRow = crudRowResult.row;
    }
    if (crudTargetRow !== undefined && typeof crudTargetRow['id'] === 'string') {
      step.targetRowId = crudTargetRow['id'] as string;
      // `cause` (below) was already built from the step's PRE-resolution
      // `targetRowId` (undefined) — patch it so `frame.cause.targetRowId`
      // reports the row `tick()` actually resolved and dispatched against,
      // not the stale planner-time value.
      cause.targetRowId = step.targetRowId;
      // C1-V11 item 3: stamp the picked row into the step's OWN payload
      // now — never left as `{}` — so a bus-fallback dispatch (no DOM
      // affordance found for this row) carries a real id/row instead of a
      // synthesized one the persist can't resolve. `payloadRowShape`
      // (crud-delete only) maps declared field names to whole-row/id
      // shape; absent it (or for crud-edit), the base shape is `{id}`.
      if (step.payloadRowShape !== undefined) {
        for (const field of step.payloadRowShape) {
          step.payload[field.name] = field.wholeRow ? crudTargetRow : (crudTargetRow['id'] as FieldValue);
        }
      } else {
        step.payload['id'] = crudTargetRow['id'] as FieldValue;
      }
    }
  }

  // C1-V9 item A: derive and switch the viewer this tick's dispatch(es)
  // need. A creator preamble's OWN requirement governs the whole call
  // (same live row it is about to establish); otherwise the step's own
  // requirement applies. `driver.setPersona` absent (a driver that can't
  // switch personas) is treated the same as "couldn't resolve" — fail
  // closed rather than dispatch under the wrong viewer and misreport a
  // real access denial as a verifier bug, or vice versa.
  const viewerRequirement: ViewerRequirement | undefined =
    step.establishesRow?.viewerRequirement ?? step.viewerRequirement;
  let personaSwitched = false;
  // Set only when this requirement's own payload needs the resolved id
  // stamped (create's `payloadOwnerField`) — carries the field name AND
  // the resolved id together so the two stay paired.
  let ownerStamp: { field: string; id: string } | undefined;
  if (viewerRequirement !== undefined && unreachableRow === undefined) {
    if (driver.setPersona === undefined) {
      unreachableRow =
        `no-satisfying-persona: trait '${step.traitName}' needs a viewer switch to drive this persist, ` +
        'but the active driver cannot switch personas';
    } else {
      const rowOverride = step.bindRowFrom !== undefined && boundRow !== undefined
        ? { entityName: step.bindRowFrom.entityName, row: boundRow }
        : crudTargetRow !== undefined && crudEntityName !== undefined
          ? { entityName: crudEntityName, row: crudTargetRow }
          : undefined;
      const resolved = resolveViewerRequirement(viewerRequirement, entitiesBefore, defaultPersona, rowOverride);
      if ('error' in resolved) {
        unreachableRow = resolved.error;
      } else {
        await driver.setPersona(ctx, resolved.persona);
        personaSwitched = true;
        const payloadOwnerField = viewerRequirement.owner?.payloadOwnerField;
        if (payloadOwnerField !== undefined && resolved.persona.id !== undefined) {
          ownerStamp = { field: payloadOwnerField, id: resolved.persona.id };
        }
      }
    }
  }
  // C1-V9 item A: create's own row must self-declare the ownership the
  // switch above just established, or its own `@create` policy denies
  // the write it is about to make. Stamped on the STEP's own payload only
  // when the requirement came from the step itself (a direct/self-binding
  // create) — a creator preamble's requirement is stamped on the
  // preamble's own payload below instead.
  if (ownerStamp !== undefined && step.establishesRow?.viewerRequirement === undefined) {
    step.payload[ownerStamp.field] = ownerStamp.id;
  }

  // C1-V9 item B (R-PERSIST-NO-ROW-KEY-SILENT-SUCCESS, the persistor
  // shape): the step's OWN persist reads its target row (or id) directly
  // from its own payload — no preamble, fill it from a seeded row right
  // before dispatch. Mutually exclusive with `establishesRow` (the
  // planner never sets both).
  if (step.bindRowFrom !== undefined && unreachableRow === undefined) {
    const { entityName, payloadField, wholeRow } = step.bindRowFrom;
    const seedRow = boundRow;
    if (seedRow === undefined) {
      unreachableRow =
        `no target row: '${entityName}' has no seeded row available at dispatch time for trait ` +
        `'${step.traitName}' — the persistor's own payload field '${payloadField}' cannot bind a real row` +
        (boundRowReason !== undefined ? ` (${boundRowReason})` : '');
    } else {
      // Scalar-id shape (`wholeRow: false`): the DISPATCHED field always
      // wants the seeded row's OWN `id`, regardless of what the field
      // itself is named (`(persist delete Note ?id)` names it `id`, but
      // nothing guarantees that everywhere) — never `seedRow[payloadField]`,
      // which only happens to work when the two names coincide.
      step.payload[payloadField] = wholeRow ? seedRow : (seedRow['id'] as FieldValue);
    }
  }

  // C1-V8: dispatch the row-establishing preamble FIRST, in the SAME live
  // trait instance as this step's own dispatch below — no `driver.reset`
  // runs between them, because the outer walk loop resets once per
  // PLANNED step (an array entry), not once per `tick()` call, and this
  // whole preamble+step sequence is ONE call. `snapshot()` further down
  // still reads only "the most recent transition trace" (every driver's
  // analogue of `FakeRuntime.lastEffectResults`, overwritten by each
  // `dispatch()`), so the preamble's own persist outcome is never scored
  // as this frame's `data-mutation` verdict — `assertDataMutation` reads
  // `frame.effectResults`, which reflects only the step's own dispatch
  // below.
  //
  // C1-V14 (F4): `beforeReplay: true` means `runVerification` already
  // dispatched this SAME preamble as its own reconcile frame, earlier in
  // this reset window, before walking the replay hops that put the trait
  // in `step.from` — dispatching it again here would fire it a second
  // time against a trait instance that already has the row.
  if (
    step.establishesRow !== undefined &&
    step.establishesRow.beforeReplay !== true &&
    unreachableRow === undefined
  ) {
    const resolved = resolveEstablishRowPayload(step.establishesRow, step.traitName, entitiesBefore, ownerStamp);
    if ('unreachableRow' in resolved) {
      unreachableRow = resolved.unreachableRow;
    } else {
      await driver.sendEvent(ctx, step.establishesRow.event, asEventPayload(resolved.payload), traitScope);
      await driver.settle(ctx);
    }
  }

  let serverResponse = null;
  let domFellBackToBus = false;
  let bareDispatchSkip: string | undefined;
  let crudAffordanceAbsent: string | undefined;
  // `dispatchSent` tracks whether the driver actually dispatched the
  // event. The DOM-trigger path that finds an affordance and clicks it
  // counts as sent; otherwise it falls through to `sendEvent` and we
  // capture `send.sent`. A `false` here means the kernel failed to
  // deliver the event at all — the frame must fail closed.
  let dispatchSent: boolean;

  if (unreachableRow !== undefined) {
    // No target row (statically from the planner, or discovered dynamically
    // above) — skip the dispatch entirely rather than sending a write that
    // cannot succeed by construction.
    dispatchSent = false;
  } else if (step.triggerKind === 'tick') {
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
    if (triggered === true) {
      dispatchSent = true;
    } else if (triggered === 'no-row-affordance') {
      // I-24: the driver searched the DOM (row-scoped click, unscoped
      // fallback, and — for crud-delete — the synthetic-dispatch recovery)
      // and found NO affordance for this row action at all. This is a real
      // product defect (e.g. an `itemActions`/`browseItemActions` config
      // override removed the row's Edit/Delete control), not a payload-
      // shape problem `bareDispatchSkip` exists for — record it as a
      // finding instead of a silent bus fallback.
      crudAffordanceAbsent =
        `no row exposes '${step.event}' on trait '${step.traitName}'` +
        (orbitalName !== undefined ? ` in orbital '${orbitalName}'` : '') +
        ` — removed by an itemActions/browseItemActions config override?`;
      dispatchSent = false;
    } else if (step.requiresRowContext === true) {
      // I-23: the open event declares required payload fields a bare `{}`
      // dispatch cannot supply — the fallback would be rejected by payload
      // validation every time and read as a false FAIL. Skip honestly:
      // no dispatch, frame marked informational (observers demote, never
      // silently credit).
      bareDispatchSkip = `bare dispatch would omit required payload field(s) of '${step.event}' — no DOM affordance found`;
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

  // C1-V9 item A: restore the app's own default persona AFTER the
  // snapshot (which must reflect what THIS step produced under the
  // switched viewer) — never leave a later, unrelated step running under
  // a viewer this one only needed for itself.
  if (personaSwitched && driver.setPersona !== undefined) {
    await driver.setPersona(ctx, defaultPersona ?? null);
  }

  const effectiveServerResponse = serverResponse ?? snap.serverResponse;
  const errors = unreachableRow !== undefined
    ? [unreachableRow]
    : bareDispatchSkip !== undefined
      ? []
      : crudAffordanceAbsent !== undefined
        ? [crudAffordanceAbsent]
        : collectDispatchErrors(step, stateAfter, dispatchSent, allowStateless === true);
  const accepted = unreachableRow !== undefined
    ? false
    : bareDispatchSkip !== undefined
      ? true
      : crudAffordanceAbsent !== undefined
        ? false
        : errors.length === 0 && decideAccepted(step, stateBefore, stateAfter, effectiveServerResponse);

  return makeWalkFrame({
    ...(errors.length > 0 && { errors }),
    index,
    timestamp,
    cause: domFellBackToBus
      ? { ...cause, triggerKind: 'bus' }
      : bareDispatchSkip !== undefined
        ? { ...cause, bareDispatchSkipped: bareDispatchSkip }
        : crudAffordanceAbsent !== undefined
          ? { ...cause, crudAffordanceAbsent }
          : cause,
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
 * C1-V15 item B: build the per-row `pickTargetRow` filter from a step's
 * `affordanceDisabledExpr` — evaluated with `@almadar/evaluator`, the SAME
 * evaluator the real runtime uses to decide render-time truth (mirrors
 * `run-verification.ts`'s `siblingGuardSatisfiable`, the sole other guard-
 * truth evaluation site in this package). The expr's own bindings name
 * which wrapper key(s) under `payload`/`callsitePayload` the row belongs
 * at (`@callsitePayload.data.status` → wrapper key `data`) — read off the
 * expr itself, never assumed, so a differently-named wrapper still resolves
 * correctly. A row for which evaluation THROWS is treated as enabled: an
 * evaluator gap must not silently strand every candidate row behind a
 * false `no-target-row`.
 */
function buildAffordanceEnabledFilter(
  disabled: NonNullable<ExtendedWalkStep['affordanceDisabledExpr']>,
  eventName: string,
  fromState: string | null,
): { isEnabled: (row: EntityRow) => boolean; disabledReason: string } {
  const prefix = `@${disabled.bindingRoot}.`;
  const wrapperKeys = new Set<string>();
  for (const binding of collectBindings(disabled.expr)) {
    if (!binding.startsWith(prefix)) continue;
    const key = binding.slice(prefix.length).split('.')[0];
    if (key !== undefined && key.length > 0) wrapperKeys.add(key);
  }
  const isEnabled = (row: EntityRow): boolean => {
    const wrapped: Record<string, EntityRow> = {};
    for (const key of wrapperKeys) wrapped[key] = row;
    const base = createMinimalContext({}, {}, fromState ?? 'initial');
    const ctx = disabled.bindingRoot === 'callsitePayload'
      ? { ...base, callsitePayload: wrapped as EventPayload }
      : { ...base, payload: wrapped as EventPayload };
    try {
      return evaluateGuard(disabled.expr, ctx) !== true;
    } catch {
      return true;
    }
  };
  return {
    isEnabled,
    disabledReason:
      `every visible row's '${eventName}' affordance is disabled by its declared 'disabled' expression`,
  };
}

/**
 * C1-V14 (F4): the payload-fill logic an `establishesRow` preamble
 * dispatch needs — owner-stamping (a creator's own row must self-declare
 * the ownership a persona switch just established) and the fetch/select-
 * bound shape's seed-row fill (`bindRowFrom`) — factored out of `tick()`'s
 * in-step preamble handling so `runVerification`'s `beforeReplay` preamble
 * dispatch (a step whose replay path never traverses the row-establishing
 * transition at all, so the pipeline must dispatch it itself, before the
 * replay hops run) can reuse the SAME resolution instead of a second
 * implementation. Never dispatches anything itself — the caller sends the
 * resolved payload.
 */
export function resolveEstablishRowPayload(
  preamble: NonNullable<ExtendedWalkStep['establishesRow']>,
  traitName: string,
  entitiesBefore: EntityData,
  ownerStamp: { field: string; id: string } | undefined,
): { payload: Record<string, FieldValue> } | { unreachableRow: string } {
  const preamblePayload: Record<string, FieldValue> = { ...preamble.payload };
  // C1-V9 item A: the creator's own row must self-declare the ownership
  // the persona switch above just established.
  if (ownerStamp !== undefined && preamble.viewerRequirement !== undefined) {
    preamblePayload[ownerStamp.field] = ownerStamp.id;
  }
  if (preamble.bindRowFrom !== undefined) {
    const seedRow = entitiesBefore[preamble.bindRowFrom.entityName]?.[0];
    const seedValue = seedRow?.[preamble.bindRowFrom.payloadField];
    if (seedRow === undefined || seedValue === undefined) {
      // Fetch/select-bound shape (case 2): no seeded row of this entity
      // exists in `entitiesBefore` at dispatch time — dispatching the
      // preamble anyway would bind no real id, and the step's own
      // persist would fail the same "no row key" way this whole
      // mechanism exists to prevent. Fail closed instead of guessing.
      return {
        unreachableRow:
          `no target row: '${preamble.bindRowFrom.entityName}' has no seeded row available at dispatch ` +
          `time for trait '${traitName}' — the fetch/select preamble '${preamble.event}' cannot bind ` +
          `a real '${preamble.bindRowFrom.payloadField}'`,
      };
    }
    preamblePayload[preamble.bindRowFrom.payloadField] = seedValue;
  }
  return { payload: preamblePayload };
}

/**
 * C1-V9 item A: resolve a static {@link ViewerRequirement} into a concrete
 * persona to switch to, using live data `tick()` alone has access to — a
 * seeded row's owner column (`entitiesBefore`) or the driver's default
 * persona's own id (`useDefaultId`). Never a guess: an owner lookup that
 * finds no seeded row, or a `useDefaultId` lookup against a default
 * persona with no `id`, is a genuine `no-satisfying-persona` finding for
 * the caller to fail the frame closed on — the SAME "candidate, never a
 * proof" caveat `roleSatisfyingPolicy` documents applies here too: this
 * only picks a viewer that plausibly satisfies the policy, the real
 * evaluator inside the runtime is what actually confirms it when the step
 * dispatches.
 *
 * `rowOverride` — when the caller already picked the step's OWN target
 * row (`step.bindRowFrom`'s `pickBindableRow`, which may avoid row 0 for
 * a self-referential `delete`) — is consulted INSTEAD of `entitiesBefore`
 * when its `entityName` matches `requirement.owner.sourceEntity`, so the
 * viewer derived here is always the OWNER OF THE ROW ACTUALLY BEING
 * WRITTEN, never a different row's owner.
 */
function resolveViewerRequirement(
  requirement: ViewerRequirement,
  entitiesBefore: EntityData,
  defaultPersona: RawUserClaims | null | undefined,
  rowOverride?: { entityName: string; row: EntityRow },
): { persona: RawUserClaims } | { error: string } {
  if (requirement.role === undefined && requirement.owner === undefined) {
    return {
      error:
        'no-satisfying-persona: access policy declared, but no role or owner literal could be derived from it',
    };
  }

  const base: RawUserClaims = defaultPersona ?? {};
  let persona: RawUserClaims = requirement.role !== undefined
    ? { ...base, [requirement.role.field]: requirement.role.value }
    : { ...base };

  if (requirement.owner !== undefined) {
    const { sourceEntity, sourceField, useDefaultId } = requirement.owner;
    let ownerId: string | undefined;
    if (useDefaultId === true) {
      const defaultId = base['id'];
      ownerId = typeof defaultId === 'string' && defaultId.length > 0 ? defaultId : undefined;
      if (ownerId === undefined) {
        return {
          error: `no-satisfying-persona: no default persona id available to own '${sourceEntity}.${sourceField}'`,
        };
      }
    } else {
      const row = rowOverride?.entityName === sourceEntity ? rowOverride.row : entitiesBefore[sourceEntity]?.[0];
      const value = row?.[sourceField];
      ownerId = typeof value === 'string' && value.length > 0 ? value : undefined;
      if (ownerId === undefined) {
        return {
          error:
            `no-satisfying-persona: no seeded '${sourceEntity}' row available to derive an owner id from '${sourceField}'`,
        };
      }
    }
    persona = { ...persona, id: ownerId };
  }

  return { persona };
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
