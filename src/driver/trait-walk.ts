/**
 * walkTraitVerdict — play one trait's planned walk (`planWalk`) step by step through the engine the
 * `play_transition` probe wraps (`declaredEntityRow` + `createCircuitHooks` + `playCircuitStep`),
 * grade each step with `stepVerdict`, and stop at the first red step. Each step starts from the
 * linked entity's first seeded row, as each canvas step does. Shared by the Studio canvas and the
 * pre-deploy gate.
 */
import type { EntityRow, EventPayload, OrbitalSchema, TraitConfig } from '@almadar/core';
import { extractTraitWalkConfigs } from '../planner/extract-trait-walk-configs.js';
import { planWalk } from '../planner/plan-walk.js';
import { createCircuitHooks } from './circuit-hooks.js';
import { declaredEntityRow } from './declared-entity-row.js';
import { playCircuitStep, type PlayCircuitStepResult } from './play-step.js';
import { stepVerdict, type StepExpectation, type StepVerdict } from './step-verdict.js';

/** What a planned walk step expects of its played step. */
export function stepExpectation(step: StepExpectation): StepExpectation {
  return {
    from: step.from,
    event: step.event,
    to: step.to,
    guardCase: step.guardCase,
    ...(step.guardSteerable !== undefined ? { guardSteerable: step.guardSteerable } : {}),
    ...(step.arm !== undefined ? { arm: step.arm } : {}),
    ...(step.payloadCase !== undefined ? { payloadCase: step.payloadCase } : {}),
  };
}

export interface TraitWalkOptions {
  /** Seeded rows by entity (`buildMockData`); each step's `@entity` is the linked entity's first
   *  row, layered over its declared defaults. */
  mockData?: Readonly<Record<string, readonly EntityRow[]>>;
  config?: TraitConfig;
}

export interface WalkedStep extends StepExpectation {
  payload: EventPayload;
  result: PlayCircuitStepResult;
  verdict: StepVerdict;
}

export interface TraitWalkVerdict {
  trait: string;
  status: 'pass' | 'fail';
  /** The first red step's finding. */
  detail?: string;
  steps: WalkedStep[];
}

export async function walkTraitVerdict(schema: OrbitalSchema, traitName: string, options: TraitWalkOptions = {}): Promise<TraitWalkVerdict> {
  const target = extractTraitWalkConfigs(schema).find((c) => c.traitName === traitName);
  if (!target) throw new Error(`No trait named "${traitName}" in this schema.`);
  const seeded = target.linkedEntity !== undefined ? options.mockData?.[target.linkedEntity]?.[0] : undefined;
  const steps: WalkedStep[] = [];
  for (const planned of planWalk({ trait: target, orbital: schema, includeAutoInit: false })) {
    const expected = stepExpectation(planned);
    const payload: EventPayload = planned.payload ?? {};
    const row = declaredEntityRow(schema, target.linkedEntity, seeded);
    const result = await playCircuitStep(target, {
      from: planned.from,
      event: planned.event,
      payload,
      ...createCircuitHooks(row, planned.from, options.config),
    });
    const verdict = stepVerdict(result, expected);
    steps.push({ ...expected, payload, result, verdict });
    if (!verdict.ok) return { trait: traitName, status: 'fail', ...(verdict.detail ? { detail: verdict.detail } : {}), steps };
  }
  return { trait: traitName, status: 'pass', steps };
}
