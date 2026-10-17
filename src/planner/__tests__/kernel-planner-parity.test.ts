/**
 * TS planner vs kernel planner. Both plan the same resolved programs; every difference is reported by step.
 *
 * The kernel's planner (`verifyPlan`, orbital-core `planner.rs`) is the one planner; `planWalk` retires once this
 * list is empty. The committed baseline (`fixtures/kernel-parity/divergences.json`) is the parity worklist: the test
 * fails when a divergence appears or disappears, so closing one means updating the baseline in the same change
 * (`KERNEL_PARITY_WRITE=1 vitest run kernel-planner-parity`).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EventPayload, EventPayloadValue, OrbitalSchema } from '@almadar/core';
import type { PlanOutcome, StepWire } from '@almadar/core/kernel-wire';
import { initSync, installLanguage, verifyAffordance, verifyPlan, verifyTransientProbe } from '@almadar/kernel';
import { readLanguageBundle } from '@almadar/core/language-data';
import type { AffordanceStep, TransientOutcome } from '@almadar/core/kernel-wire';
import { extractTraitWalkConfigs } from '../extract-trait-walk-configs.js';
import { planWalk } from '../plan-walk.js';
import { collectEntityFields } from '../internal/payload-synth.js';
import { enumerateConfigVariants } from '../enumerate-config-variants.js';
import { planInitCredit } from '../plan-init-credit.js';
import { planEmitSweep } from '../plan-emit-sweep.js';
import { planClickPathSamples } from '../plan-click-path-samples.js';
import { planContractEvents, type ContractRegistry } from '../plan-contract-events.js';
import { planUserCrudFlow } from '../plan-user-crud-flow.js';
import { planTransientFailureProbes } from '../plan-transient-failure-probes.js';
import { collectEmitDeclarations } from '../../browser/catalog-probes.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures/kernel-parity');
const baselinePath = join(fixtures, 'divergences.json');
const FIXTURES = ['entity_payload_skeleton', '02-state-machine', '04-complex-guards', 'json-array', 'precondition', 'config', 'flows'] as const;

initSync({ module: readFileSync(createRequire(import.meta.url).resolve('@almadar/kernel/kernel.wasm')) });
const bundle = readLanguageBundle(join(here, '../../..'));
installLanguage(JSON.stringify(bundle));

/** One planned step in the form both planners reduce to. */
interface Row {
  key: string;
  targets: string[];
  guarded: boolean;
  solved: boolean;
  payload: string;
  guardCase: string;
  guardSteerable: string;
  siblings: string[];
  acceptStates: string[];
  navigates: boolean;
  coverageKeys: string[];
  precondition: string;
}

type Facet = 'targets' | 'guarded' | 'solved' | 'payload' | 'guardCase' | 'guardSteerable' | 'siblings' | 'acceptStates' | 'navigates' | 'coverageKey' | 'precondition' | 'successEvent' | 'rowDelta' | 'openAffordance' | 'rowContext' | 'role' | 'contractSet';

interface Divergence {
  fixture: string;
  step: string;
  kind: 'missing-in-ts' | 'missing-in-kernel' | Facet;
  kernel: string;
  ts: string;
}

const sorted = (values: readonly string[]): string[] => [...new Set(values)].sort();

function kernelPrecondition(step: StepWire): string {
  const pre = step.precondition;
  if (pre === undefined) return '';
  if (pre.kind === 'established') return `established:${pre.trait}:${pre.event}`;
  return pre.kind === 'unreachable' ? 'unreachable' : '';
}

function tsPrecondition(step: ReturnType<typeof planWalk>[number]): string {
  if (step.establishesRow !== undefined) return `established:${step.establishesRow.traitName ?? step.traitName}:${step.establishesRow.event}`;
  return step.unreachableRowReason !== undefined ? 'unreachable' : '';
}

function kernelRows(program: OrbitalSchema): Row[] {
  const outcome = JSON.parse(verifyPlan(JSON.stringify(program), '')) as PlanOutcome;
  if (outcome.outcome !== 'planned') throw new Error(`the kernel refused the program: ${JSON.stringify(outcome.failure)}`);
  return outcome.steps
    .filter((step) => step.reply === undefined)
    .map((step: StepWire) => ({
      key: `${step.trait}|${step.from}|${step.event}|${step.guarded ? String(step.arm) : '*'}|${step.payloadCase}`,
      targets: sorted(step.toStates),
      guarded: step.guarded,
      // The kernel is the oracle: TS reads an unsteerable guard as unsolved, so "solved" means solved and steerable on both sides.
      solved: step.solved && step.guardSteerable !== false,
      payload: stable(step.payload),
      guardCase: step.guardCase ?? '',
      guardSteerable: step.guardSteerable === undefined ? '' : String(step.guardSteerable),
      siblings: sorted(step.guardSiblingTargets ?? []),
      acceptStates: sorted(step.acceptStates ?? []),
      navigates: step.navigates,
      coverageKeys: [step.coverageKey],
      precondition: kernelPrecondition(step),
    }));
}

function tsRows(program: OrbitalSchema): Row[] {
  const entityFieldsByName = collectEntityFields(program);
  const rows = new Map<string, Row>();
  for (const trait of extractTraitWalkConfigs(program)) {
    for (const step of planWalk({ trait, entityFieldsByName, orbital: program })) {
      const guarded = trait.transitions.some((t) => t.from === step.from && t.event === step.event && t.hasGuard);
      const payloadCase = step.payloadCase ?? 'success';
      const key = `${step.traitName}|${step.from}|${step.event}|${guarded ? String(step.arm) : '*'}|${payloadCase}`;
      const existing = rows.get(key);
      if (existing === undefined) {
        rows.set(key, {
          key,
          targets: [step.to],
          guarded,
          solved: step.inconclusive === undefined && step.guardSteerable !== false,
          payload: stable(step.payload),
          guardCase: step.guardCase ?? '',
          guardSteerable: step.guardSteerable === undefined ? '' : String(step.guardSteerable),
          siblings: sorted(step.guardSiblingTargets ?? []),
          acceptStates: sorted(step.acceptStates ?? []),
          navigates: step.navigates === true,
          coverageKeys: [step.coverageKey],
          precondition: tsPrecondition(step),
        });
      } else {
        existing.targets = sorted([...existing.targets, step.to]);
        existing.coverageKeys.push(step.coverageKey);
        existing.acceptStates = sorted([...existing.acceptStates, ...(step.acceptStates ?? [])]);
      }
    }
  }
  return [...rows.values()];
}

function stable(value: StepWire['payload'] | EventPayload | EventPayloadValue | undefined): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value);
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function diffPlans(fixture: string, kernel: Row[], ts: Row[]): Divergence[] {
  const out: Divergence[] = [];
  const tsByKey = new Map(ts.map((r) => [r.key, r]));
  const kernelByKey = new Map(kernel.map((r) => [r.key, r]));
  for (const k of kernel) {
    const t = tsByKey.get(k.key);
    if (t === undefined) {
      out.push({ fixture, step: k.key, kind: 'missing-in-ts', kernel: k.targets.join(','), ts: '' });
      continue;
    }
    const facet = (kind: Facet, kernelValue: string, tsValue: string): void => {
      if (kernelValue !== tsValue) out.push({ fixture, step: k.key, kind, kernel: kernelValue, ts: tsValue });
    };
    facet('targets', k.targets.join(','), t.targets.join(','));
    facet('guarded', String(k.guarded), String(t.guarded));
    facet('solved', String(k.solved), String(t.solved));
    facet('payload', k.payload, t.payload);
    facet('guardCase', k.guardCase, t.guardCase);
    facet('guardSteerable', k.guardSteerable, t.guardSteerable);
    facet('siblings', k.siblings.join(','), t.siblings.join(','));
    facet('acceptStates', k.acceptStates.join(','), t.acceptStates.join(','));
    facet('navigates', String(k.navigates), String(t.navigates));
    facet('precondition', k.precondition, t.precondition);
    facet('coverageKey', k.coverageKeys.join(','), t.coverageKeys.includes(k.coverageKeys[0]) ? k.coverageKeys[0] : t.coverageKeys.join(','));
  }
  for (const t of ts) {
    if (!kernelByKey.has(t.key)) out.push({ fixture, step: t.key, kind: 'missing-in-kernel', kernel: '', ts: t.targets.join(',') });
  }
  return out.sort((a, b) => (a.step + a.kind).localeCompare(b.step + b.kind));
}

/** Config sweeps and boot credits: the kernel varies only declared values; TS also samples number knobs. */
function sweepDivergences(fixture: string, program: OrbitalSchema): Divergence[] {
  const outcome = JSON.parse(verifyPlan(JSON.stringify(program), '')) as PlanOutcome;
  if (outcome.outcome !== 'planned') throw new Error('the kernel refused the program');
  const out: Divergence[] = [];
  const traitConfigs = new Map(extractTraitWalkConfigs(program).map((t) => [t.traitName, t]));
  for (const orbital of program.orbitals) {
    for (const trait of orbital.traits ?? []) {
      if (typeof trait === 'string' || !('stateMachine' in trait)) continue;
      const kernel = outcome.configVariants.find((c) => c.trait === trait.name);
      const kernelLabels = sorted((kernel?.variants ?? []).map((v) => v.label));
      const tsLabels = sorted(enumerateConfigVariants(trait.config ?? {}).map((v) => v.label));
      for (const label of tsLabels.filter((l) => !kernelLabels.includes(l))) {
        out.push({ fixture, step: `${trait.name}|config|${label}`, kind: 'missing-in-kernel', kernel: '', ts: label });
      }
      for (const label of kernelLabels.filter((l) => !tsLabels.includes(l))) {
        out.push({ fixture, step: `${trait.name}|config|${label}`, kind: 'missing-in-ts', kernel: label, ts: '' });
      }
      const config = traitConfigs.get(trait.name);
      const credit = outcome.initCredits.find((c) => c.trait === trait.name);
      const tsCredit = config === undefined ? '' : planInitCredit(config).coverageKey;
      if ((credit?.coverageKey ?? '') !== tsCredit) {
        out.push({ fixture, step: `${trait.name}|init-credit`, kind: 'coverageKey', kernel: credit?.coverageKey ?? '', ts: tsCredit });
      }
    }
  }
  return out;
}

const flowKey = (kind: string, ...parts: string[]): string => `${kind}|${parts.join('|')}`;

/** The flow planners: emit sweep, contract events, affordance clicks, CRUD chains and the forced-failure probe. */
function flowDivergences(fixture: string, program: OrbitalSchema): Divergence[] {
  const out: Divergence[] = [];
  const note = (step: string, kind: Divergence['kind'], kernel: string, ts: string): void => {
    if (kernel !== ts) out.push({ fixture, step, kind, kernel, ts });
  };
  const outcome = JSON.parse(verifyPlan(JSON.stringify(program), '')) as PlanOutcome;
  if (outcome.outcome !== 'planned') throw new Error('the kernel refused the program');
  const configs = new Map(extractTraitWalkConfigs(program).map((t) => [t.traitName, t]));

  for (const orb of program.orbitals) {
    for (const trait of orb.traits ?? []) {
      if (typeof trait === 'string' || !('stateMachine' in trait) || trait.stateMachine === undefined) continue;
      const config = configs.get(trait.name);
      if (config === undefined) continue;
      const emits = collectEmitDeclarations(trait.stateMachine.transitions.flatMap((t) => t.effects ?? []));
      const tsSweep = planEmitSweep({ trait: config, emits, schema: program, orb });
      const kernelSweep = outcome.emitSweep.filter((e) => e.trait === trait.name);
      for (const t of tsSweep) {
        const k = kernelSweep.find((e) => e.event === t.event);
        const step = flowKey('emit', trait.name, t.event);
        if (k === undefined) out.push({ fixture, step, kind: 'missing-in-kernel', kernel: '', ts: t.event });
        else {
          note(step, 'coverageKey', k.coverageKey, t.coverageKey);
          note(step, 'navigates', String(k.navigates), String(t.navigates === true));
          note(step, 'payload', stable(k.payload), stable(t.payload));
        }
      }
      for (const k of kernelSweep) {
        if (!tsSweep.some((t) => t.event === k.event)) out.push({ fixture, step: flowKey('emit', trait.name, k.event), kind: 'missing-in-ts', kernel: k.event, ts: '' });
      }
    }
  }

  const registry: ContractRegistry = JSON.parse(bundle.core.eventContracts).contracts;
  const tsContract = planContractEvents(program, registry);
  note(flowKey('contract', '*'), 'contractSet', sorted(outcome.contractEvents.steps.map((c) => `${c.event}:${c.pattern}`)).join(','), sorted(tsContract.map((c) => `${c.event}:${c.coverageKey.replace(/^.*\[contract:(.*)\]$/, '$1')}`)).join(','));

  for (const t of planClickPathSamples(program)) {
    const kernel = JSON.parse(verifyAffordance(JSON.stringify(program), JSON.stringify({ trait: t.traitName, from: t.from, event: t.event }), '')) as AffordanceStep | null;
    const step = flowKey('affordance', t.traitName, t.from, t.event);
    if (kernel === null) {
      out.push({ fixture, step, kind: 'missing-in-kernel', kernel: '', ts: t.event });
      continue;
    }
    note(step, 'targets', kernel.to, t.to);
    note(step, 'navigates', String(kernel.navigates), String(t.navigates === true));
    note(step, 'coverageKey', kernel.coverageKey, t.coverageKey.replace(/\[click-path:[^\]]*\]$/, '[affordance]'));
    note(step, 'precondition', kernel.precondition?.kind === 'established' ? `established:${kernel.precondition.trait}:${kernel.precondition.event}` : kernel.precondition?.kind === 'unreachable' ? 'unreachable' : '', t.establishesRow !== undefined ? `established:${t.establishesRow.traitName ?? t.traitName}:${t.establishesRow.event}` : t.unreachableRowReason !== undefined ? 'unreachable' : '');
  }

  const tsCrud = planUserCrudFlow(program);
  for (const t of tsCrud) {
    const step = flowKey('crud', t.traitName, t.from, t.event, t.testKind ?? '');
    const kind = (t.testKind ?? '').replace('crud-', '');
    const k = outcome.crudChains.find((c) => c.sourceTrait === t.traitName && c.openFrom === t.from && c.openEvent === t.event && c.kind === kind);
    if (k === undefined) {
      out.push({ fixture, step, kind: 'missing-in-kernel', kernel: '', ts: t.event });
      continue;
    }
    note(step, 'successEvent', k.successEvent, t.expectedSuccessEvent ?? '');
    note(step, 'rowDelta', String(k.rowDelta), String(t.expectedRowDelta?.delta ?? ''));
    note(step, 'openAffordance', k.openAffordanceEvent, t.openAffordanceEvent ?? t.event);
    note(step, 'rowContext', String(k.requiresRowContext), String(t.requiresRowContext === true));
  }
  for (const k of outcome.crudChains.filter((c) => c.opensOverlay)) {
    if (!tsCrud.some((t) => t.traitName === k.sourceTrait && t.event === k.openEvent && (t.testKind ?? '') === `crud-${k.kind}`)) {
      out.push({ fixture, step: flowKey('crud', k.sourceTrait, k.openFrom, k.openEvent, `crud-${k.kind}`), kind: 'missing-in-ts', kernel: k.openEvent, ts: '' });
    }
  }

  for (const t of planTransientFailureProbes(program, [{ traitName: 'Flow', from: 'saving', event: 'FAILED', to: 'failed', slot: 'main', pattern: null }], configs).steps) {
    const kernel = JSON.parse(verifyTransientProbe(JSON.stringify(program), JSON.stringify({ trait: 'Flow', from: 'saving', event: 'FAILED', to: 'failed' }), '')) as TransientOutcome | null;
    const step = flowKey('transient', t.traitName, t.from, t.event);
    if (kernel === null || kernel.outcome !== 'probe') {
      out.push({ fixture, step, kind: 'missing-in-kernel', kernel: kernel?.outcome ?? 'null', ts: t.event });
      continue;
    }
    note(step, 'coverageKey', kernel.step.coverageKey, t.coverageKey);
    note(step, 'acceptStates', sorted(kernel.step.acceptStates).join(','), sorted(t.acceptStates ?? []).join(','));
    note(step, 'role', kernel.step.role.value, t.viewerRequirement?.role?.value ?? '');
    note(step, 'payload', stable(kernel.step.payload), stable(t.payload));
  }
  return out;
}

function program(name: string): OrbitalSchema {
  return JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8')) as OrbitalSchema;
}

describe('kernel planner parity', () => {
  it('reports every TS-vs-kernel divergence by step against the committed worklist', () => {
    const all: Divergence[] = [];
    for (const name of FIXTURES) {
      const p = program(name);
      const kernel = kernelRows(p);
      const ts = tsRows(p);
      expect(kernel.length, `${name}: kernel plans steps`).toBeGreaterThan(0);
      expect(ts.length, `${name}: the TS planner plans steps`).toBeGreaterThan(0);
      all.push(...diffPlans(name, kernel, ts), ...sweepDivergences(name, p), ...flowDivergences(name, p));
    }
    if (process.env.KERNEL_PARITY_WRITE === '1') writeFileSync(baselinePath, `${JSON.stringify(all, null, 2)}\n`);
    expect(all).toEqual(JSON.parse(readFileSync(baselinePath, 'utf8')) as Divergence[]);
  });

  it('control: a changed target, a dropped step and an extra step are each reported', () => {
    const p = program('02-state-machine');
    const kernel = kernelRows(p);
    const ts = tsRows(p);
    const changed = ts.map((r, i) => (i === 0 ? { ...r, targets: ['__nowhere__'] } : r));
    expect(diffPlans('c', kernel, changed).some((d) => d.step === ts[0].key && d.kind === 'targets')).toBe(true);
    expect(diffPlans('c', kernel, ts.slice(1)).some((d) => d.step === ts[0].key && d.kind === 'missing-in-ts')).toBe(true);
    expect(diffPlans('c', kernel.slice(1), ts).some((d) => d.step === kernel[0].key && d.kind === 'missing-in-kernel')).toBe(true);
    expect(diffPlans('c', kernel, kernel)).toEqual([]);
  });
});
