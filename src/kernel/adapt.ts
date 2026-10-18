/**
 * Kernel plan -> the driver's step vocabulary. The kernel decides what to fire and what to expect; these adapters
 * only reshape its typed wire into the `ExtendedWalkStep` the browser driver already fires (`tick()`).
 *
 * @packageDocumentation
 */

import type { EventPayload } from '@almadar/core';
import type { FieldValue, JsonValue, OrbitalSchema } from '@almadar/core';
import type { ArmConflict, ContractStep, StepWire, DataMutation, PreambleEvent, RowEstablish, ViewerRequirement, EmitStep, Precondition, TickStep, TransientFinding, TransientProbe } from '@almadar/core/kernel-wire';
import type { PortalExpectation } from '../observer/types.js';
import type { KernelPlanner } from './kernel-planner.js';
import type { ExtendedWalkStep } from '../planner/types.js';
import type { PlannedProgram } from './kernel-planner.js';

/** A kernel payload is an object by construction; anything else is an empty payload. */
export function asEventPayload(value: JsonValue): EventPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function emitStep(step: EmitStep): ExtendedWalkStep {
  return {
    from: step.from,
    event: step.event,
    to: step.from,
    guardCase: null,
    payload: asEventPayload(step.payload),
    isRepositioning: false,
    traitName: step.trait,
    triggerKind: 'bus',
    coverageKey: step.coverageKey,
    ...(step.navigates && { navigates: true }),
  };
}

/** One bus step per event the trait's effects emit or its `emits` contract declares, fired from the initial state. */
export function emitSweepSteps(planned: PlannedProgram, traitName: string): ExtendedWalkStep[] {
  return planned.emitSweep.filter((step) => step.trait === traitName).map(emitStep);
}

function tickStep(step: TickStep): ExtendedWalkStep {
  return {
    from: step.from,
    event: step.event,
    to: step.from,
    guardCase: null,
    payload: {},
    isRepositioning: false,
    traitName: step.trait,
    triggerKind: 'tick',
    coverageKey: step.coverageKey,
    waitMs: step.waitMs,
    acceptStates: step.acceptStates,
  };
}

/** One wait-and-observe step per numeric tick the trait declares. */
export function tickSteps(planned: PlannedProgram, traitName: string): ExtendedWalkStep[] {
  return planned.tickSteps.filter((step) => step.trait === traitName).map(tickStep);
}

function contractStep(step: ContractStep): ExtendedWalkStep {
  return {
    from: step.from,
    event: step.event,
    to: step.from,
    guardCase: null,
    payload: {},
    isRepositioning: false,
    traitName: step.trait,
    triggerKind: 'dom',
    coverageKey: step.coverageKey,
    testKind: 'contract',
  };
}

/** The events the rendered patterns must emit, from the event-contract table the kernel reads. */
export function contractSteps(planned: PlannedProgram): ExtendedWalkStep[] {
  return planned.contractEvents.steps.map(contractStep);
}

/** A failure arm the walk cannot force, with the kernel's typed reason. */
export interface TransientArmFinding {
  traitName: string;
  from: string;
  event: string;
  to: string;
  reason: string;
}

export interface TransientFailureProbeResult {
  steps: ExtendedWalkStep[];
  findings: TransientArmFinding[];
}

function transientReason(armLabel: string, finding: TransientFinding): string {
  return finding.kind === 'no-entering-persist'
    ? `'${armLabel}' races forward via an effect-emitted sibling, and no persist effect anywhere in the trait declares 'emit.failure: ${finding.event}' to force`
    : `'${armLabel}' races forward via an effect-emitted sibling, and no viewer denies '${finding.operation}' on '${finding.entity}' — the entering transition's own persist can't be forced to fail`;
}

function probeStep(probe: TransientProbe): ExtendedWalkStep {
  return {
    from: probe.from,
    event: probe.event,
    to: probe.to,
    guardCase: null,
    payload: asEventPayload(probe.payload),
    isRepositioning: false,
    traitName: probe.trait,
    triggerKind: 'bus',
    coverageKey: probe.coverageKey,
    viewerRequirement: { role: probe.role },
    verifiesPortalFor: {
      traitName: probe.verifiesPortalFor.trait,
      from: probe.verifiesPortalFor.from,
      event: probe.verifiesPortalFor.event,
      to: probe.verifiesPortalFor.to,
    },
    ...(probe.acceptStates.length > 1 && { acceptStates: probe.acceptStates }),
  };
}

/**
 * For each portal expectation the host derived from the render scan, ask the kernel whether it is a transient failure
 * arm and, if so, how to force it: a probe step through the entering persist as a viewer its policy denies, or the
 * typed reason it cannot be forced.
 */
export async function transientFailureProbes(
  kernel: KernelPlanner,
  program: OrbitalSchema,
  expectations: ReadonlyArray<PortalExpectation>,
): Promise<TransientFailureProbeResult> {
  const result: TransientFailureProbeResult = { steps: [], findings: [] };
  for (const exp of expectations) {
    const outcome = await kernel.transientProbe(program, { trait: exp.traitName, from: exp.from, event: exp.event, to: exp.to });
    if (outcome === null || outcome.outcome === 'not-transient') continue;
    if (outcome.outcome === 'probe') {
      result.steps.push(probeStep(outcome.step));
      continue;
    }
    result.findings.push({
      traitName: exp.traitName,
      from: exp.from,
      event: exp.event,
      to: exp.to,
      reason: transientReason(`${exp.traitName}:${exp.from}+${exp.event}->${exp.to}`, outcome.finding),
    });
  }
  return result;
}

/** A kernel payload as the row-establishing preamble's field record. */
export function asFieldRecord(value: JsonValue): Record<string, FieldValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

/**
 * The preamble a guarded step needs, in the driver's vocabulary: the setter to dispatch first (with the row to bind
 * and the viewer to be), or the reason no setter can satisfy the guard. A same-trait setter the replay path may not
 * run is typed `unproven` by the kernel and plans nothing here.
 */
export function establishFromPrecondition(
  precondition: Precondition | undefined,
): Pick<ExtendedWalkStep, 'establishesRow' | 'unreachableRowReason'> {
  if (precondition === undefined || precondition.kind === 'same-trait-setter') return {};
  if (precondition.kind === 'unreachable') {
    return { unreachableRowReason: `guard-precondition-unreachable: no transition on this trait or any sibling trait ever sets '@entity.${precondition.fields.join("', '@entity.")}' to a value that satisfies the guard` };
  }
  return {
    establishesRow: {
      event: precondition.event,
      payload: asFieldRecord(precondition.payload),
      traitName: precondition.trait,
      beforeReplay: true,
      establishAtState: precondition.establishAtState,
      ...(precondition.bindRowFrom !== undefined && {
        bindRowFrom: { entityName: precondition.bindRowFrom.entity, payloadField: precondition.bindRowFrom.payloadField },
      }),
      ...(precondition.role !== undefined && { viewerRequirement: { role: precondition.role } }),
    },
  };
}

/**
 * The reconcile hops that place a fresh trait in `state`, as replay steps: each is a real dispatch the runtime
 * accepts (effect-emitted events are fired by their effect, never replayed). `null` when `state` is unreachable.
 */
export async function replayTo(
  kernel: KernelPlanner,
  program: OrbitalSchema,
  traitName: string,
  state: string,
): Promise<ExtendedWalkStep[] | null> {
  const hops = await kernel.replay(program, traitName, state);
  return hops === null ? null : hops.map((hop) => replayStep(traitName, hop));
}

export function replayStep(traitName: string, hop: PreambleEvent): ExtendedWalkStep {
  return {
    from: hop.from,
    event: hop.event,
    to: hop.to,
    guardCase: null,
    payload: asEventPayload(hop.payload),
    isRepositioning: true,
    traitName,
    triggerKind: 'replay',
    coverageKey: `${traitName}:${hop.from}+${hop.event}->${hop.to}[replay]`,
    ...(hop.acceptStates !== undefined && hop.acceptStates.length > 1 && { acceptStates: hop.acceptStates }),
    ...(hop.navigates && { navigates: true }),
  };
}

/** The row-establishing preamble of an update or delete step, in the driver's vocabulary. */
export function establishFromRowEstablish(
  establish: RowEstablish | undefined,
): Pick<ExtendedWalkStep, 'establishesRow' | 'unreachableRowReason'> {
  if (establish === undefined) return {};
  if (establish.kind === 'unreachable') {
    return {
      unreachableRowReason:
        `no target row: trait '${establish.trait}' declares no create+id-bind self-loop and no @payload id-binding `
        + `transition reachable from '${establish.atState}' — the '${establish.entity}' row this step writes to can never exist `
        + 'before it fires',
    };
  }
  return {
    establishesRow: {
      event: establish.event,
      payload: asFieldRecord(establish.payload),
      ...(establish.bindRowFrom !== undefined && {
        bindRowFrom: { entityName: establish.bindRowFrom.entity, payloadField: establish.bindRowFrom.payloadField },
      }),
      ...(establish.viewer !== undefined && { viewerRequirement: establish.viewer }),
      ...(establish.beforeReplay && { beforeReplay: true }),
    },
  };
}

function viewerOf(viewer: ViewerRequirement | undefined): Pick<ExtendedWalkStep, 'viewerRequirement'> {
  return viewer === undefined ? {} : { viewerRequirement: viewer };
}

function dataMutationStep(m: DataMutation): ExtendedWalkStep {
  const establish = m.rowEstablish !== undefined ? establishFromRowEstablish(m.rowEstablish) : establishFromPrecondition(m.precondition);
  return {
    from: m.from,
    event: m.event,
    to: m.to,
    guardCase: null,
    payload: asEventPayload(m.payload),
    isRepositioning: false,
    traitName: m.trait,
    triggerKind: 'dom',
    coverageKey: m.coverageKey,
    testKind: 'data-mutation',
    expectedRowDelta: { entityName: m.entity, delta: m.rowDelta },
    ...(m.successEvent !== undefined && { expectedSuccessEvent: m.successEvent }),
    ...establish,
    ...(m.bindRow !== undefined && {
      bindRowFrom: {
        entityName: m.entity,
        payloadField: m.bindRow.payloadField,
        wholeRow: m.bindRow.wholeRow,
        ...((m.avoidReferencedVia ?? []).length > 0 && { avoidReferencedVia: m.avoidReferencedVia }),
        ...((m.avoidReferencedByOtherEntities ?? []).length > 0 && {
          avoidReferencedByOtherEntities: (m.avoidReferencedByOtherEntities ?? []).map((r) => ({ entityName: r.entity, fieldName: r.field })),
        }),
      },
    }),
    ...(establish.establishesRow?.viewerRequirement === undefined ? viewerOf(m.viewer) : {}),
  };
}

/** One DOM-triggered CRUD step per persist-writing transition, with the rows it must leave behind. */
export function dataMutationSteps(planned: PlannedProgram): ExtendedWalkStep[] {
  return planned.dataMutations.map(dataMutationStep);
}

export function inconclusiveReason(step: Pick<StepWire, 'from' | 'event' | 'to'>, conflict: ArmConflict): string {
  const arm = `${step.from} --${step.event}--> ${step.to}`;
  switch (conflict.kind) {
    case 'earlier-arm-first':
      return `${arm}: the solved payload passes the earlier arm ${conflict.arm} (--> ${conflict.to}) first`;
    case 'guard-unmet':
      return `${arm}: the solved payload does not pass this arm's guard`;
    case 'own-guard-passes':
      return `${arm}: the solved payload does not fail this arm's guard`;
    case 'guard-unevaluable':
      return `${arm}: the guard of arm ${conflict.arm} could not be evaluated on the solved payload (${conflict.message})`;
  }
}

export function walkStep(step: StepWire): ExtendedWalkStep {
  return {
    from: step.from,
    event: step.event,
    to: step.to,
    guardCase: step.guardCase ?? null,
    payload: asEventPayload(step.payload),
    isRepositioning: false,
    traitName: step.trait,
    triggerKind: 'bus',
    coverageKey: step.coverageKey,
    payloadCase: step.payloadCase,
    ...(step.arm !== undefined && { arm: step.arm }),
    ...(step.guardSteerable !== undefined && { guardSteerable: step.guardSteerable }),
    ...((step.guardSiblingTargets ?? []).length > 0 && { guardSiblingTargets: step.guardSiblingTargets }),
    ...((step.acceptStates ?? []).length > 0 && { acceptStates: step.acceptStates }),
    ...(step.navigates && { navigates: true }),
    ...(step.armConflict !== undefined && { guardSteerable: false, inconclusive: inconclusiveReason(step, step.armConflict) }),
    ...(step.guardCase === 'pass' ? establishFromPrecondition(step.precondition) : {}),
  };
}

/**
 * The trait's base walk: the boot credit, then one step per transition variant the kernel plans (the full payload, the
 * empty payload the validator must reject, the payload that fails the guard). An `http` reply route is credited by
 * its request's own dispatch, so it is never planned as a step.
 */
export function walkSteps(planned: PlannedProgram, traitName: string, options: { includeAutoInit?: boolean } = {}): ExtendedWalkStep[] {
  const out: ExtendedWalkStep[] = [];
  const credit = planned.initCredits.find((c) => c.trait === traitName);
  if (options.includeAutoInit !== false && credit !== undefined) {
    out.push({
      from: credit.state,
      event: 'INIT',
      to: credit.state,
      guardCase: null,
      payload: {},
      isRepositioning: false,
      traitName,
      triggerKind: 'auto-init',
      coverageKey: credit.coverageKey,
    });
  }
  return [...out, ...walkWire(planned, traitName).map(walkStep)];
}

/** The kernel's planned steps for a trait's walk, in order: no `http` reply route, no repeat of the boot INIT. */
export function walkWire(planned: PlannedProgram, traitName: string): StepWire[] {
  const bootStates = new Set(planned.initCredits.filter((c) => c.trait === traitName).map((c) => c.state));
  return planned.steps.filter((step) => step.trait === traitName && step.reply === undefined && !(step.event === 'INIT' && bootStates.has(step.from)));
}
