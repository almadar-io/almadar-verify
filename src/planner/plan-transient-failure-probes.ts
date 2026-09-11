/**
 * `planTransientFailureProbes` — RV Verification_Runtime item 27.
 *
 * For each `PortalExpectation` whose (traitName, from, event) is a
 * transient failure-route arm (see `transient-failure-arm.ts`), plans a
 * FORCED-FAILURE step: dispatch the transition that ENTERS `from` under
 * a viewer the target entity's own declared policy denies, so the
 * failure event fires for real (the runtime's own cascade, not a
 * synthetic injection into a state the machine already left). The step
 * carries `verifiesPortalFor` — the nominal failure arm this dispatch's
 * cascade is expected to prove, distinct from the literal `(from, event,
 * to)` actually dispatched — so `assertTransientFailureArmPortals` can
 * check the portal against the RIGHT transition once the cascade lands.
 *
 * When no denying viewer can be derived, no step is planned; the
 * expectation is reported instead as a `TransientArmFinding` —
 * informational, never a false "slot not mounted".
 *
 * Pure. No `Page`, no driver, no live entity data.
 *
 * @packageDocumentation
 */

import type { OrbitalSchema, Trait } from '@almadar/core';
import { buildGuardPayloads, constTruth } from '@almadar/core';
import type { ExtendedWalkStep } from './types.js';
import type { TraitWalkConfig } from '../engine/types.js';
import type { PortalExpectation } from '../observer/types.js';
import { eachInlineTrait } from './internal/orbital-walk.js';
import { collectEntityFields, synthesizeSuccessPayload } from './internal/payload-synth.js';
import { transientClosure } from './internal/transient-closure.js';
import {
  deriveDenyingViewer,
  findEnteringPersist,
  isTransientFailureArm,
} from './internal/transient-failure-arm.js';

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

export function planTransientFailureProbes(
  schema: OrbitalSchema,
  portalExpectations: ReadonlyArray<PortalExpectation>,
  walkConfigsByName: ReadonlyMap<string, TraitWalkConfig>,
): TransientFailureProbeResult {
  const steps: ExtendedWalkStep[] = [];
  const findings: TransientArmFinding[] = [];
  if (portalExpectations.length === 0) return { steps, findings };

  const traitsByName = new Map<string, Trait>();
  for (const { trait } of eachInlineTrait(schema)) traitsByName.set(trait.name, trait);
  const entityFieldsByName = collectEntityFields(schema);

  for (const exp of portalExpectations) {
    const trait = traitsByName.get(exp.traitName);
    const walkConfig = walkConfigsByName.get(exp.traitName);
    if (trait?.stateMachine === undefined || walkConfig === undefined) continue;
    const transitions = trait.stateMachine.transitions;
    if (!isTransientFailureArm(exp.from, exp.event, transitions, walkConfig)) continue;

    const armLabel = `${exp.traitName}:${exp.from}+${exp.event}->${exp.to}`;
    const entering = findEnteringPersist(transitions, exp.event);
    if (entering === null) {
      findings.push({
        traitName: exp.traitName,
        from: exp.from,
        event: exp.event,
        to: exp.to,
        reason: `'${armLabel}' races forward via an effect-emitted sibling, and no persist effect anywhere in the trait declares 'emit.failure: ${exp.event}' to force`,
      });
      continue;
    }

    const denyingViewer = deriveDenyingViewer(schema, entering.entity, entering.kind, entering.data);
    if (denyingViewer === undefined) {
      findings.push({
        traitName: exp.traitName,
        from: exp.from,
        event: exp.event,
        to: exp.to,
        reason: `'${armLabel}' races forward via an effect-emitted sibling, and no viewer denies '${entering.kind}' on '${entering.entity}' — the entering transition's own persist can't be forced to fail`,
      });
      continue;
    }

    const enter = entering.transition;
    const eventDecl = walkConfig.events?.find((e) => e.key === enter.event);
    let payload = synthesizeSuccessPayload(eventDecl?.payloadSchema, walkConfig.linkedEntity, entityFieldsByName);
    if (enter.guard !== undefined && enter.guard !== null && constTruth(enter.guard) !== false) {
      payload = { ...payload, ...buildGuardPayloads(enter.guard).pass };
    }

    const closureTransition = walkConfig.transitions.find((t) => t.from === enter.from && t.event === enter.event);
    const acceptStates = closureTransition !== undefined
      ? transientClosure(closureTransition.to, walkConfig)
      : undefined;

    steps.push({
      from: enter.from,
      event: enter.event,
      to: enter.to,
      guardCase: null,
      payload,
      isRepositioning: false,
      traitName: exp.traitName,
      triggerKind: 'bus',
      coverageKey: `${exp.traitName}:${enter.from}+${enter.event}->${enter.to}[transient-failure-probe:${exp.event}]`,
      viewerRequirement: denyingViewer,
      verifiesPortalFor: { traitName: exp.traitName, from: exp.from, event: exp.event, to: exp.to },
      ...(acceptStates !== undefined && acceptStates.length > 1 && { acceptStates }),
    });
  }

  return { steps, findings };
}
