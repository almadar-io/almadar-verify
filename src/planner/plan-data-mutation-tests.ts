/**
 * `planDataMutationTests` — pure planner that produces ExtendedWalkSteps
 * for CRUD verification. Each test maps to one DOM-trigger step
 * (preceded by replay-path steps if needed) carrying the expected
 * row-count delta on its FrameCause for `assertDataMutation` to read.
 *
 * Pre-v3.0.0 this lived in orbital `phase4-browser.ts:3357-3655`. That
 * code navigated to each test's route, replayed paths, clicked
 * affordances, and inspected post-click DOM row counts imperatively.
 *
 * The lifted shape: each `DataMutationTestSpec` (orbital projects from
 * its `DataMutationTest`) emits:
 *   - Zero or more `triggerKind: 'replay'` steps (one per ReplayStep)
 *   - One terminal `triggerKind: 'dom'` step with
 *     `testKind: 'data-mutation'` and `expectedRowDelta` set
 *
 * The kernel walks them via `tick`. The Driver's `triggerDOM` clicks
 * the affordance. The Frame after settle carries the entity changes
 * computed by `frame/factory.diffEntities`. `assertDataMutation` (pure
 * observer) reads `frame.cause.expectedRowDelta` and verifies it
 * matches `frame.entityChanges`.
 *
 * Pure. No `Page`. No DOM.
 *
 * @packageDocumentation
 */

import type { ReplayStep } from '@almadar/core';
import type { TraitWalkConfig } from '../engine/types.js';
import type { ExtendedWalkStep } from './types.js';

/**
 * Minimal data-mutation-test shape verify owns. Tools project their
 * schema-shape mutation tests (orbital's `DataMutationTest`) into
 * this. The traitName + event identify the transition; mutationType
 * + linkedEntity drive the expected row delta.
 */
export interface DataMutationTestSpec {
  trait: string;
  event: string;
  fromState: string;
  linkedEntity: string;
  mutationType: 'create' | 'update' | 'delete';
  /** Steps to replay first to reach `fromState`. May be empty. */
  replayPath: ReadonlyArray<ReplayStep>;
}

export interface PlanDataMutationTestsInput {
  traits: ReadonlyArray<TraitWalkConfig>;
  tests: ReadonlyArray<DataMutationTestSpec>;
}

export function planDataMutationTests(input: PlanDataMutationTestsInput): ExtendedWalkStep[] {
  const traitByName = new Map<string, TraitWalkConfig>();
  for (const trait of input.traits) {
    traitByName.set(trait.traitName, trait);
  }

  const result: ExtendedWalkStep[] = [];

  for (const test of input.tests) {
    const trait = traitByName.get(test.trait);
    if (trait === undefined) continue;

    // Expand replay path inline — each ReplayStep becomes its own
    // ExtendedWalkStep with triggerKind: 'replay'. Keeps tick simple
    // (no `step.replayPath` recursion) and slots replay frames into
    // the same temporal stream as everything else.
    for (const replay of test.replayPath) {
      result.push({
        from: replay.fromState,
        event: replay.event,
        to: replay.toState,
        guardCase: null,
        payload: replay.guardPayload ?? {},
        isRepositioning: true,
        traitName: test.trait,
        triggerKind: 'replay',
        coverageKey: `${test.trait}:${replay.fromState}+${replay.event}->${replay.toState}[replay:data-mutation:${test.event}]`,
      });
    }

    const expectedDelta = deltaFor(test.mutationType);

    result.push({
      from: test.fromState,
      event: test.event,
      to: test.fromState,                  // observer doesn't gate on `to`; row delta is the truth
      guardCase: null,
      payload: {},
      isRepositioning: false,
      traitName: test.trait,
      triggerKind: 'dom',
      coverageKey: `${test.trait}:${test.fromState}+${test.event}->${test.fromState}[data-mutation:${test.mutationType}]`,
      testKind: 'data-mutation',
      expectedRowDelta: { entityName: test.linkedEntity, delta: expectedDelta },
    });
  }

  return result;
}

/**
 * +1 on create, -1 on delete, 0 on update. Matches the convention the
 * v3.0.0 `MutationRule.expectedDelta` already uses in `assertMutation`.
 */
function deltaFor(mutationType: 'create' | 'update' | 'delete'): number {
  if (mutationType === 'create') return 1;
  if (mutationType === 'delete') return -1;
  return 0;
}
