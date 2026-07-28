/**
 * `planInteractionTests` — pure planner that produces ExtendedWalkSteps
 * for Phase 4b interaction testing.
 *
 * Reads the parsed `OrbitalSchema` directly: walks each trait's
 * `stateMachine.transitions[].effects[]` looking for `render-ui`
 * effects targeting a slot. Each transition that opens a target
 * pattern (modal, form-section, detail-panel, etc.) becomes one
 * DOM-trigger step:
 *   - `triggerKind: 'dom'`, `testKind: 'interaction'`
 *   - `expectedPattern` = top-level `type` of the rendered payload
 *   - `formData` (when target pattern is a form, derived from the
 *     transition's payload schema + linked entity field metadata)
 *   - Preceded by `triggerKind: 'replay'` steps when fromState !=
 *     initialState (via `planReplayTo` — the one replay planner, so hops
 *     carry synthesized payloads and skip effect-emitted events).
 *
 * Pure. No `Page`, no DOM, no schema-side helpers — operates on the
 * typed `@almadar/core` `OrbitalSchema`.
 *
 * @packageDocumentation
 */

import type { FieldValue, OrbitalSchema, SExpr, Trait, Transition } from '@almadar/core';
import { isEntityReference, isEntityCall } from '@almadar/core';
import type { ExtendedWalkStep } from './types.js';
import {
  eachInlineTrait,
  findInitialState,
} from './internal/orbital-walk.js';
import { buildMinimalPayload, type EntityFieldDef } from '../browser/interaction.js';
import { extractTraitWalkConfigs } from './extract-trait-walk-configs.js';
import { planReplayTo } from './plan-replay-to.js';

export function planInteractionTests(orbital: OrbitalSchema): ExtendedWalkStep[] {
  const result: ExtendedWalkStep[] = [];
  const entityFieldsByName = collectEntityFields(orbital);

  // Repositioning preambles go through the ONE replay planner
  // (`planReplayTo`): payload synthesis from the event's declared schema,
  // guard-pass merge, and effect-emitted-hop exclusion. The private BFS this
  // planner used to carry dispatched every hop with `{}` — any hop whose
  // event requires payload fields (OPEN_X `id!`) was validator-rejected, the
  // precondition never established, and every steady-detail arm
  // (`viewing_single`) stayed uncovered (the std-trial/std-dunning class).
  const walkConfigs = new Map(
    extractTraitWalkConfigs(orbital).map((c) => [c.traitName, c]),
  );

  // Orbital-wide set of events surfaced as DOM affordances anywhere
  // (`action: "EVENT"`, `submitEvent: "EVENT"`). Buttons that fire a
  // sibling trait's event (e.g. a list trait with an "+" button that
  // dispatches ADD_ITEM into a separate detail trait) live outside
  // the trait owning the transition, so this set spans the whole
  // orbital, not just the trait currently being planned.
  const userClickableEvents = collectClickableEventsAcrossOrbital(orbital);

  // Server-emitted events: every `emit.success` / `emit.failure` value
  // across all `fetch` / `persist` / `call-service` / `ref` effects in
  // the orbital. These arrive on the cascade after a server round-trip
  // and have no DOM affordance — driving them via interaction tests is
  // a guaranteed-uncovered miss that drags coverage down.
  const serverEmittedEvents = collectServerEmittedEvents(orbital);

  for (const { trait } of eachInlineTrait(orbital)) {
    if (trait.stateMachine === undefined) continue;
    const initial = findInitialState(trait.stateMachine);
    if (initial === null) continue;

    for (const transition of trait.stateMachine.transitions) {
      if (transition.event === 'INIT') continue;
      if (serverEmittedEvents.has(transition.event)) continue;
      if (!userClickableEvents.has(transition.event)) continue;

      const renderTarget = findRenderTarget(transition);
      if (renderTarget === null) continue;

      const walkConfig = walkConfigs.get(trait.name);
      const replayPath = walkConfig !== undefined
        ? planReplayTo({ trait: walkConfig, targetState: transition.from }, entityFieldsByName)
        : null;
      if (replayPath === null) continue;

      // Replay steps first (retagged so coverage attributes the hop to the
      // interaction under test).
      for (const step of replayPath) {
        result.push({
          ...step,
          coverageKey: `${trait.name}:${step.from}+${step.event}->${step.to}[replay:interaction:${transition.event}]`,
        });
      }

      // Build form data — derivation strategies, in priority order:
      //   1. Nested form-section with explicit `fields: [...]` —
      //      drives the form-fill regardless of where the form lives
      //      in the render tree.
      //   2. Nested form-section with empty `fields: []` (form pattern
      //      delegates to the linked entity's fields at render time —
      //      std-modal's default form-section shape). Synthesize from
      //      `entityFields[linkedEntity]`.
      //   3. Top-level pattern is itself a form (`form`, `form-section`,
      //      or object with `fields:` directly) — use the event's
      //      payloadSchema.
      //   4. Otherwise: undefined → driver just clicks the affordance.
      const linkedEntity = trait.linkedEntity;
      const nestedForm = findNestedForm(transition);
      let formData: Record<string, FieldValue> | undefined;
      if (nestedForm !== null && nestedForm.fields.length > 0) {
        const fieldNames = nestedForm.fields.map((n) => ({ name: n, type: 'string' as const }));
        formData = buildFormData(fieldNames, linkedEntity, entityFieldsByName);
      } else if (nestedForm !== null && linkedEntity !== undefined) {
        // Form-section delegated to the linked entity — synthesize
        // form values from the entity's fields directly.
        const entityFields = entityFieldsByName[linkedEntity] ?? [];
        const synthSchema = entityFields
          .filter((f) => f.name !== 'id' && f.name !== 'createdAt' && f.name !== 'updatedAt')
          .map((f) => ({ name: f.name, type: f.type ?? 'string' }));
        formData = synthSchema.length > 0
          ? buildFormData(synthSchema, linkedEntity, entityFieldsByName)
          : undefined;
      } else {
        const payloadSchema = extractPayloadSchema(trait, transition.event);
        formData = renderTarget.isForm && payloadSchema.length > 0
          ? buildFormData(payloadSchema, linkedEntity, entityFieldsByName)
          : undefined;
      }

      result.push({
        from: transition.from,
        event: transition.event,
        to: transition.to,
        guardCase: null,
        payload: {},
        isRepositioning: false,
        traitName: trait.name,
        triggerKind: 'dom',
        coverageKey: `${trait.name}:${transition.from}+${transition.event}->${transition.to}[interaction]`,
        testKind: 'interaction',
        expectedPattern: renderTarget.pattern,
        ...(formData !== undefined && { formData }),
        ...(nestedForm?.submitEvent !== undefined && { submitEvent: nestedForm.submitEvent }),
      });
    }
  }

  return result;
}

// ── internal ─────────────────────────────────────────────────────────

interface RenderTarget {
  pattern: string;
  isForm: boolean;
}

/**
 * Orbital-wide scan: every event that appears as `action:` or
 * `submitEvent:` in any trait's render-ui. Driving an interaction test
 * for an event not in this set means clicking nothing — the kernel
 * would fall back to a bus dispatch and lose the user-path semantics
 * the test was meant to cover.
 */
function collectClickableEventsAcrossOrbital(orbital: OrbitalSchema): Set<string> {
  const out = new Set<string>();
  for (const { trait } of eachInlineTrait(orbital)) {
    if (trait.stateMachine === undefined) continue;
    for (const transition of trait.stateMachine.transitions) {
      for (const effect of transition.effects ?? []) {
        if (!Array.isArray(effect)) continue;
        if (effect[0] !== 'render-ui') continue;
        walkActions(effect[2], out);
      }
    }
  }
  return out;
}

/**
 * Orbital-wide scan: every event named in any `emit.success` /
 * `emit.failure` block on a `fetch` / `persist` / `call-service` /
 * `ref` effect. These events arrive over the server cascade and have
 * no DOM affordance.
 */
function collectServerEmittedEvents(orbital: OrbitalSchema): Set<string> {
  const out = new Set<string>();
  const SERVER_OPS = new Set(['fetch', 'persist', 'call-service', 'ref']);
  for (const { trait } of eachInlineTrait(orbital)) {
    if (trait.stateMachine === undefined) continue;
    for (const transition of trait.stateMachine.transitions) {
      for (const effect of transition.effects ?? []) {
        if (!Array.isArray(effect)) continue;
        if (typeof effect[0] !== 'string' || !SERVER_OPS.has(effect[0])) continue;
        // Last element is the options object that may carry `emit`.
        for (let i = 2; i < effect.length; i++) {
          const node = effect[i];
          if (node === null || typeof node !== 'object' || Array.isArray(node)) continue;
          const emit = (node as Readonly<Record<string, SExpr>>)['emit'];
          if (emit === null || typeof emit !== 'object' || Array.isArray(emit)) continue;
          const options = emit as Readonly<Record<string, SExpr>>;
          if (typeof options['success'] === 'string') out.add(options['success']);
          if (typeof options['failure'] === 'string') out.add(options['failure']);
        }
      }
    }
  }
  return out;
}

function walkActions(node: SExpr, out: Set<string>): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkActions(child, out);
    return;
  }
  const obj = node as Readonly<Record<string, SExpr>>;
  if (typeof obj['action'] === 'string') out.add(obj['action']);
  if (typeof obj['submitEvent'] === 'string') out.add(obj['submitEvent']);
  for (const v of Object.values(obj)) {
    if (typeof v === 'object' && v !== null) walkActions(v, out);
  }
}

/**
 * Walk a transition's `render-ui` payload(s) looking for a nested form
 * (object with a `fields:` array, typically `type: "form-section"` but
 * not required). Returns the field name list when found — used by the
 * interaction planner to derive `formData` so the driver can fill the
 * form even when the top-level rendered pattern is a wrapper (modal,
 * stack) and not the form itself.
 */
interface NestedForm {
  fields: ReadonlyArray<string>;
  submitEvent?: string;
}

function findNestedForm(transition: Transition): NestedForm | null {
  for (const effect of transition.effects ?? []) {
    if (!Array.isArray(effect)) continue;
    if (effect[0] !== 'render-ui') continue;
    const found = walkForFormFields(effect[2] as SExpr);
    if (found !== null) return found;
  }
  return null;
}

function walkForFormFields(node: SExpr): NestedForm | null {
  if (node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = walkForFormFields(item);
      if (found !== null) return found;
    }
    return null;
  }
  const obj = node as Readonly<Record<string, SExpr>>;
  // Direct hit: an object with a `fields:` array. Two flavors:
  //   - Object-style: `[{ name: "X", type: "string", ... }]`
  //   - String-style: `["X", "Y", "Z"]` — std-modal's default form-section
  //     ships this shape and delegates type info to the linked entity at
  //     render time (Form.tsx normalizes via entity lookup).
  const fields = obj['fields'];
  if (Array.isArray(fields)) {
    const names: string[] = [];
    for (const f of fields) {
      if (typeof f === 'string' && f.length > 0) {
        names.push(f);
      } else if (f !== null && typeof f === 'object' && !Array.isArray(f)) {
        const name = (f as Readonly<Record<string, SExpr>>)['name'];
        if (typeof name === 'string') names.push(name);
      }
    }
    if (names.length > 0) {
      const submitEvent = obj['submitEvent'];
      return {
        fields: names,
        ...(typeof submitEvent === 'string' && { submitEvent }),
      };
    }
  }
  // Recurse into children + every other object-valued property.
  for (const value of Object.values(obj)) {
    if (typeof value === 'object' && value !== null) {
      const found = walkForFormFields(value);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Find the topmost rendered pattern in a transition's `render-ui` effects.
 * Returns null when no render-ui effect renders a non-null pattern.
 * Detects forms by either pattern name (`form`, `form-section`) or by
 * the presence of `fields:` arrays in the rendered config.
 */
function findRenderTarget(transition: Transition): RenderTarget | null {
  for (const effect of transition.effects ?? []) {
    if (!Array.isArray(effect)) continue;
    if (effect[0] !== 'render-ui') continue;
    const payload = effect[2];
    if (payload === null || typeof payload !== 'object') continue;
    const obj = payload as Readonly<Record<string, SExpr>>;
    const patternType = obj['type'];
    if (typeof patternType !== 'string') continue;

    const pattern = patternType;
    const isForm = pattern.includes('form') || Array.isArray(obj['fields']);
    return { pattern, isForm };
  }
  return null;
}

/**
 * Pull the payload schema for an event from the trait's `stateMachine.events[]`.
 * Returns [] when the event has no declared payload.
 */
function extractPayloadSchema(
  trait: Trait,
  eventKey: string,
): Array<{ name: string; type: string; required?: boolean }> {
  const event = trait.stateMachine?.events.find((e) => e.key === eventKey);
  if (event === undefined || event.payloadSchema === undefined) return [];
  return event.payloadSchema.map((f) => ({
    name: f.name,
    type: f.type,
    required: f.required,
  }));
}

/**
 * Collect entity field definitions across all orbitals, keyed by entity
 * name. Uses core's `isEntityReference` / `isEntityCall` guards to
 * narrow the `Entity | string | EntityCall` union. The inline
 * `OrbitalEntity` carries the canonical `fields[]`; `EntityCall` may
 * also carry caller-added `fields[]` (those override inherited ones).
 * String refs are skipped — their fields live on the imported entity,
 * which the inline phase should have resolved before this planner runs.
 */
function collectEntityFields(orbital: OrbitalSchema): Record<string, EntityFieldDef[]> {
  const out: Record<string, EntityFieldDef[]> = {};
  for (const orb of orbital.orbitals) {
    const entity = orb.entity;
    if (entity === undefined) continue;
    if (isEntityReference(entity)) continue;     // bare string ref — resolved upstream

    if (isEntityCall(entity)) {
      // EntityCall extends an imported entity; record only the
      // caller-added fields (the parent's fields lived on the imported
      // entity, which the inline phase should have folded into a
      // sibling inline definition).
      const callName = entity.name;
      const callFields = entity.fields;
      if (callName === undefined || callFields === undefined) continue;
      out[callName] = callFields.filter(hasName).map(toFieldDef);
      continue;
    }

    out[entity.name] = entity.fields.filter(hasName).map(toFieldDef);
  }
  return out;
}

/**
 * EntityField.name is optional in @almadar/core 7+ (matches the Rust IR
 * FieldDefinition.name: Option<String>). Top-level entity fields all
 * carry a name; nameless nested item descriptors don't.
 */
function hasName<T extends { name?: string }>(f: T): f is T & { name: string } {
  return typeof f.name === 'string' && f.name.length > 0;
}

function toFieldDef(f: { name: string; type: string; values?: readonly string[] }): EntityFieldDef {
  return {
    name: f.name,
    type: f.type,
    values: f.values !== undefined ? [...f.values] : undefined,
  };
}

/**
 * Generate FieldValue-typed mock form data using `buildMinimalPayload`.
 * The cast at the boundary (`as Record<string, FieldValue>`) is safe
 * because every value `buildMinimalPayload` produces falls within the
 * `FieldValue` union (string, number, boolean, Date, null).
 */
function buildFormData(
  schema: Array<{ name: string; type: string; required?: boolean }>,
  linkedEntity: string | undefined,
  entityFields: Record<string, EntityFieldDef[]>,
): Record<string, FieldValue> | undefined {
  const fields = linkedEntity !== undefined ? entityFields[linkedEntity] : undefined;
  const fieldsMut = fields !== undefined ? [...fields] : undefined;
  const raw = buildMinimalPayload(schema, fieldsMut);
  return raw as Record<string, FieldValue>;
}
