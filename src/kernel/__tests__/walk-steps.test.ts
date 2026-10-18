/**
 * `walkSteps` — the driver's view of the kernel's per-trait walk. The TS `planWalk` retired into the kernel planner
 * (`orbital-core` `planner.rs`, `verify/plan_wire.rs`); its tests moved as follows.
 *
 *   auto-init, coverage keys, no-INIT trait, guard-fail key, http reply routes: this file.
 *   acceptStates (transient closure):      verify::plan_wire  a_target_reachable_only_through_a_transient_closure_is_reached_by_the_hop_into_its_source
 *   guardSteerable:                        verify::plan_wire  a_guard_is_steerable_only_when_every_binding_it_reads_is_a_payload_path
 *   guardSiblingTargets / fail-on-sibling: verify::plan_wire  a_fail_payload_that_still_passes_its_own_guard_is_unsolved_and_a_catching_sibling_is_named
 *   preamble for a guard over an entity:   verify::plan_wire  a_guard_reading_an_entity_field_a_sibling_sets_plans_that_sibling_as_the_preamble
 *   unreachable precondition:              verify::plan_wire  control_a_setter_that_writes_an_unsatisfying_value_leaves_the_precondition_unreachable
 *   str/default fail steering:             verify::plan_wire  the_guard_solver_steers_every_canonical_payload_guard_shape_and_the_evaluator_agrees
 *   array/len rows from the entity:        verify::plan_wire  a_guard_over_an_array_length_gets_rows_shaped_from_the_declared_entity
 *   conformGuardPayload (typed values):    verify::plan_wire  a_bare_binding_guard_gets_a_value_of_the_declared_type, control_the_failing_payload_of_a_bare_binding_guard_is_falsy_in_the_declared_type
 *   per-arm solving, overlapping arms:     verify::plan_wire  an_arm_an_earlier_arm_takes_first_is_unsolved_with_the_typed_conflict, control_disjoint_arms_each_take_their_own_payload
 *   json/parse payloads and guards:        verify::plan_wire  a_payload_field_read_through_json_parse_is_the_json_text_of_a_minimal_instance, each_arm_json_member_is_solved_from_its_guard, two_json_members_are_solved_together_and_an_unsolvable_guard_stays_unsolved
 *   http routes are not standalone steps:  verify::flows  the_emit_sweep_covers_effect_emitted_events_and_declared_emits_but_no_http_reply_route
 *
 * The TS-vs-kernel parity test (kernel-planner-parity, with its fixtures and divergences.json) retired with the last
 * TS planner: it compared two planners and only one is left. The kernel's own planning is pinned by the Rust tests
 * above and by the wasm goldens (orbital-wasm tests/fixtures/verify/*.plan.json).
 */

import { describe, expect, it } from 'vitest';
import type { OrbitalSchema, Trait } from '@almadar/core';
import { walkSteps } from '../adapt.js';
import { kernelPlan } from './kernel-steps.js';

function program(trait: Trait): OrbitalSchema {
  return {
    name: 'walk',
    designTokens: {},
    customPatterns: {},
    orbitals: [
      {
        name: 'WalkOrbital',
        entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
        pages: [],
        traits: [trait],
      },
    ],
  };
}

const browse: Trait = {
  name: 'BrowseItemBrowse',
  scope: 'instance',
  linkedEntity: 'Item',
  stateMachine: {
    states: [{ name: 'loading', isInitial: true }, { name: 'browsing' }, { name: 'error' }],
    events: [{ key: 'INIT', name: 'Init' }, { key: 'LOADED', name: 'Loaded' }, { key: 'LOAD_FAILED', name: 'Failed' }],
    transitions: [
      { from: 'loading', to: 'loading', event: 'INIT', effects: [] },
      { from: 'loading', to: 'browsing', event: 'LOADED', effects: [] },
      { from: 'loading', to: 'error', event: 'LOAD_FAILED', effects: [] },
      { from: 'browsing', to: 'loading', event: 'INIT', effects: [] },
      { from: 'error', to: 'loading', event: 'INIT', effects: [] },
    ],
  },
};

describe('walkSteps', () => {
  it('prepends the auto-init step the trait boots with, and skips it when asked', () => {
    const planned = kernelPlan(program(browse));
    const steps = walkSteps(planned, 'BrowseItemBrowse');
    expect(steps[0]).toMatchObject({ triggerKind: 'auto-init', event: 'INIT', from: 'loading', to: 'loading', coverageKey: 'BrowseItemBrowse:loading+INIT->loading' });
    expect(walkSteps(planned, 'BrowseItemBrowse', { includeAutoInit: false }).every((s) => s.triggerKind !== 'auto-init')).toBe(true);
  });

  it('covers every walkable edge with a stable coverage key and does not repeat the boot INIT', () => {
    const keys = walkSteps(kernelPlan(program(browse)), 'BrowseItemBrowse').map((s) => s.coverageKey);
    expect(keys).toEqual(expect.arrayContaining([
      'BrowseItemBrowse:loading+INIT->loading',
      'BrowseItemBrowse:loading+LOADED->browsing[success]',
      'BrowseItemBrowse:loading+LOAD_FAILED->error[success]',
      'BrowseItemBrowse:browsing+INIT->loading[success]',
      'BrowseItemBrowse:error+INIT->loading[success]',
    ]));
    expect(keys.filter((k) => k === 'BrowseItemBrowse:loading+INIT->loading')).toHaveLength(1);
  });

  it('a trait with no INIT transition walks its one edge after the auto-init step', () => {
    const trait: Trait = {
      name: 'X',
      scope: 'instance',
      linkedEntity: 'Item',
      stateMachine: {
        states: [{ name: 'a', isInitial: true }, { name: 'b' }],
        events: [{ key: 'GO', name: 'Go' }],
        transitions: [{ from: 'a', to: 'b', event: 'GO', effects: [] }],
      },
    };
    const steps = walkSteps(kernelPlan(program(trait)), 'X');
    expect(steps.map((s) => s.event)).toEqual(['INIT', 'GO']);
  });

  it('a guarded transition is walked as a pass and a guard-fail variant', () => {
    const trait: Trait = {
      name: 'Guarded',
      scope: 'instance',
      linkedEntity: 'Item',
      stateMachine: {
        states: [{ name: 'a', isInitial: true }, { name: 'b' }],
        events: [{ key: 'TRY', name: 'Try', payloadSchema: [{ name: 'qty', type: 'number', required: true }] }, { key: 'BACK', name: 'Back' }],
        transitions: [
          { from: 'a', to: 'b', event: 'TRY', guard: ['>', '@payload.qty', 0], effects: [] },
          { from: 'b', to: 'a', event: 'BACK', effects: [] },
        ],
      },
    };
    const keys = walkSteps(kernelPlan(program(trait)), 'Guarded').filter((s) => s.event === 'TRY').map((s) => s.coverageKey);
    expect(keys).toContain('Guarded:a+TRY->b[success]');
    expect(keys).toContain('Guarded:a+TRY->b[guard-fail]');
  });

  it('control: another trait of the program contributes no steps', () => {
    expect(walkSteps(kernelPlan(program(browse)), 'Missing')).toEqual([]);
  });
});
