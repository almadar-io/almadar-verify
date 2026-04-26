/**
 * `planInteractionTests` — pure planner that produces ExtendedWalkSteps
 * for Phase 4b interaction testing.
 *
 * Pre-v3.0.0 this lived in orbital `phase4-browser.ts:2280-3356`. That
 * 1076-line block iterated each `InteractionTest`, navigated to the
 * test's route, replayed the path to `fromState`, clicked the
 * affordance (with form-fill if the target pattern was a form), then
 * inspected the DOM imperatively to verify the expected pattern
 * mounted. Verdicts emitted as it went.
 *
 * The lifted shape: each `InteractionTestSpec` (orbital projects from
 * its `InteractionTest`) emits:
 *   - Zero or more `triggerKind: 'replay'` steps (one per ReplayStep)
 *   - One `triggerKind: 'dom'` trigger step with:
 *       testKind: 'interaction'
 *       expectedPattern: the target pattern name (modal, form-section, etc.)
 *       formData: built from payloadSchema + entityFields when the
 *                 target pattern is a form (Driver.triggerDOM honors it)
 *
 * The kernel walks them via `tick`. The Driver clicks the affordance
 * (and fills the form if `formData` is set). The Frame after settle
 * carries the post-click `domSnapshot.portals` (verify-owned). The
 * `assertInteractionPattern` observer reads `cause.expectedPattern`
 * + `frame.domSnapshot.portals` to verify the modal opened (or the
 * state advanced).
 *
 * Pure. No `Page`. No DOM.
 *
 * @packageDocumentation
 */

import type { FieldValue, ReplayStep } from '@almadar/core';
import type { TraitWalkConfig } from '../engine/types.js';
import type { ExtendedWalkStep } from './types.js';
import {
  buildMinimalPayload,
  type EntityFieldDef,
} from '../browser/interaction.js';

export interface InteractionTestSpec {
  trait: string;
  event: string;
  fromState: string;
  toState: string;
  /** Render slot the target pattern lives in: 'modal', 'main', 'drawer', etc. */
  slot: string;
  /** Pattern name expected in the target slot: 'form-section', 'modal', 'detail-panel', ... */
  targetPattern: string;
  /** Pattern category from the registry: 'form', 'display', 'component', etc. */
  patternCategory: string;
  /** Linked entity name (used for form mock-data generation). */
  linkedEntity: string;
  /** Whether the affordance lives inside an entity row (needs data to render). */
  needsEntityData: boolean;
  /** Payload schema used to derive form mock data when the target is a form. */
  payloadSchema: ReadonlyArray<{ name: string; type: string; required?: boolean; mockValue?: string }>;
  /** Steps to replay first to reach `fromState`. */
  replayPath: ReadonlyArray<ReplayStep>;
  /**
   * Which guard branch this test exercises. 'unguarded' for transitions
   * without a guard. 'pass'/'fail' for guarded transitions, where the
   * planner uses `guardPayload` as the form/event payload.
   */
  guardBranch: 'unguarded' | 'pass' | 'fail';
  /** Pre-derived guard payload for guarded transitions; ignored when guardBranch === 'unguarded'. */
  guardPayload?: Record<string, FieldValue>;
}

export interface PlanInteractionTestsInput {
  traits: ReadonlyArray<TraitWalkConfig>;
  tests: ReadonlyArray<InteractionTestSpec>;
  /**
   * Per-entity field metadata. Used to generate FieldValue-typed form
   * data via `buildMinimalPayload` when the test targets a form
   * pattern. Keyed by entityName.
   */
  entityFields?: Record<string, ReadonlyArray<EntityFieldDef>>;
}

export function planInteractionTests(input: PlanInteractionTestsInput): ExtendedWalkStep[] {
  const traitByName = new Map<string, TraitWalkConfig>();
  for (const trait of input.traits) {
    traitByName.set(trait.traitName, trait);
  }

  const result: ExtendedWalkStep[] = [];

  for (const test of input.tests) {
    const trait = traitByName.get(test.trait);
    if (trait === undefined) continue;

    // Expand replay path inline.
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
        coverageKey: `${test.trait}:${replay.fromState}+${replay.event}->${replay.toState}[replay:interaction:${test.event}]`,
      });
    }

    // Build form data if the target pattern is a form. `buildMinimalPayload`
    // returns Record<string, unknown> with FieldValue-compatible runtime
    // values (strings, numbers, booleans, dates). The cast at the
    // boundary is safe because every value the helper produces falls
    // within the FieldValue type's union.
    const isForm = test.patternCategory === 'form' || test.targetPattern.includes('form');
    let formData: Record<string, FieldValue> | undefined;
    if (isForm && test.payloadSchema.length > 0) {
      const entityFields = input.entityFields?.[test.linkedEntity];
      // Convert readonly arrays to mutable copies — buildMinimalPayload's
      // signature is pre-v3.0.0 and expects mutable arrays. The function
      // doesn't mutate them; the spread is purely a type bridge.
      const entityFieldsMut = entityFields !== undefined ? [...entityFields] : undefined;
      const raw = buildMinimalPayload([...test.payloadSchema], entityFieldsMut);
      formData = raw as Record<string, FieldValue>;
    }

    // Guard branches: 'unguarded'/'pass' fire the transition, 'fail' tests it stays.
    const guardCase = test.guardBranch === 'unguarded' ? null : test.guardBranch;
    const payload = test.guardBranch !== 'unguarded' && test.guardPayload !== undefined
      ? test.guardPayload
      : {};

    const branchSuffix = test.guardBranch === 'unguarded' ? '' : `[${test.guardBranch}]`;

    result.push({
      from: test.fromState,
      event: test.event,
      to: test.guardBranch === 'fail' ? test.fromState : test.toState,
      guardCase,
      payload,
      isRepositioning: false,
      traitName: test.trait,
      triggerKind: 'dom',
      coverageKey: `${test.trait}:${test.fromState}+${test.event}->${test.toState}[interaction]${branchSuffix}`,
      testKind: 'interaction',
      expectedPattern: test.guardBranch === 'fail' ? undefined : test.targetPattern,
      ...(formData !== undefined && { formData }),
    });
  }

  return result;
}
