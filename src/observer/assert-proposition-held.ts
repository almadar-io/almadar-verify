/**
 * `proposition-held` — every hop the page ran whose fired arm declares `@ensures` kept it, judged by the kernel
 * (`verifyProposition`) on the trait's `@entity` before and after the hop. The page's kernel records that pair only
 * when a verifier attached (`setRecordEntityAfter`, EXEC-STEP-10) and carries it on the hop's `observed`.
 *
 * `undefined` when no hop the page ran declares one. Each hop is judged once, in the first frame whose snapshot shows
 * it (every frame carries the page's transition log). A hop that persists is inconclusive: the client kernel hands the
 * write to its host, so the row it judges would not hold it.
 *
 * @packageDocumentation
 */

import type { OrbitalSchema, TransitionTrace } from '@almadar/core';
import type { PropositionObservation } from '@almadar/core/kernel-wire';
import type { Frame } from '../frame/types.js';
import type { KernelPlanner } from '../kernel/kernel-planner.js';
import { ensuresOf } from '../driver/trait-walk.js';
import type { Verdict } from './types.js';

function observationOf(trace: TransitionTrace): PropositionObservation | undefined {
  const observed = trace.observed;
  if (observed === undefined) return undefined;
  const persisted = trace.effects.some((e) => e.type === 'persist');
  return {
    executed: true,
    failed: trace.effects.some((e) => e.status === 'failed'),
    entityBefore: observed.entityBefore,
    entityAfter: observed.entityAfter,
    payload: observed.payload,
    ...(persisted ? { unobserved: 'the hop persists, and the client kernel hands that write to its host' } : {}),
  };
}

export async function assertPropositionHeld(
  frames: ReadonlyArray<Frame>,
  schema: OrbitalSchema,
  kernel: Pick<KernelPlanner, 'proposition'>,
): Promise<Verdict | undefined> {
  const seen = new Set<string>();
  const broken: string[] = [];
  const inconclusive: string[] = [];
  const frameIndices: number[] = [];
  let judged = 0;
  for (const frame of frames) {
    for (const trace of frame.runtimeSnapshot.transitions) {
      if (seen.has(trace.id)) continue;
      seen.add(trace.id);
      const observation = observationOf(trace);
      if (observation === undefined) continue;
      const ensures = ensuresOf(schema, trace.traitName, trace.from, trace.event, trace.firedArm);
      if (ensures.length === 0) continue;
      judged += 1;
      const hop = `${trace.traitName}: ${trace.from} --${trace.event}--> ${trace.to}`;
      const verdict = await kernel.proposition(ensures, observation);
      if (verdict.verdict === 'broken') {
        broken.push(`${hop} broke @ensures ${JSON.stringify(verdict.proposition)}`);
        if (!frameIndices.includes(frame.index)) frameIndices.push(frame.index);
      } else if (verdict.verdict === 'inconclusive') {
        inconclusive.push(`${hop}: ${verdict.reason}`);
      }
    }
  }
  if (judged === 0) return undefined;
  if (broken.length > 0) {
    return { passed: false, detail: `proposition-held: ${broken.join('; ')}`, evidence: { frameIndices } };
  }
  const note = inconclusive.length > 0 ? `; inconclusive: ${inconclusive.join('; ')}` : '';
  return { passed: true, detail: `proposition-held: ${judged} hop(s) kept their @ensures${note}` };
}
