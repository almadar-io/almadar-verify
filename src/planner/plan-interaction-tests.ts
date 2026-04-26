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
 *     initialState (BFS shortest path inline).
 *
 * Pure. No `Page`, no DOM, no schema-side helpers — operates on the
 * typed `@almadar/core` `OrbitalSchema`.
 *
 * @packageDocumentation
 */

import type { FieldValue, OrbitalSchema, Trait, Transition } from '@almadar/core';
import { isEntityReference, isEntityCall } from '@almadar/core';
import type { ExtendedWalkStep } from './types.js';
import {
  eachInlineTrait,
  findInitialState,
} from './internal/orbital-walk.js';
import { buildMinimalPayload, type EntityFieldDef } from '../browser/interaction.js';

export function planInteractionTests(orbital: OrbitalSchema): ExtendedWalkStep[] {
  const result: ExtendedWalkStep[] = [];
  const entityFieldsByName = collectEntityFields(orbital);

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

      const replayPath = bfsReplayPath(trait, initial, transition.from);
      if (replayPath === null) continue;

      // Replay steps first.
      for (const step of replayPath) {
        result.push({
          from: step.from,
          event: step.event,
          to: step.to,
          guardCase: null,
          payload: {},
          isRepositioning: true,
          traitName: trait.name,
          triggerKind: 'replay',
          coverageKey: `${trait.name}:${step.from}+${step.event}->${step.to}[replay:interaction:${transition.event}]`,
        });
      }

      // Build form data — three derivation strategies, in priority order:
      //   1. Nested form-section inside the render-ui (e.g. modal opens
      //      a form-section whose `submitEvent` cascades to SAVE).
      //      Drives the form-fill regardless of where the form lives in
      //      the render tree. Used by std-cart's ADD_ITEM → modal[
      //      form-section{ name, description, status, submitEvent: SAVE }].
      //   2. Top-level pattern is a form (`form`, `form-section`, or
      //      object with `fields:` directly).
      //   3. Otherwise: undefined → driver just clicks the affordance.
      const linkedEntity = trait.linkedEntity;
      const nestedForm = findNestedForm(transition);
      let formData: Record<string, FieldValue> | undefined;
      if (nestedForm !== null) {
        const fieldNames = nestedForm.fields.map((n) => ({ name: n, type: 'string' as const }));
        formData = buildFormData(fieldNames, linkedEntity, entityFieldsByName);
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
          const emit = (node as { emit?: { success?: unknown; failure?: unknown } }).emit;
          if (emit === undefined) continue;
          if (typeof emit.success === 'string') out.add(emit.success);
          if (typeof emit.failure === 'string') out.add(emit.failure);
        }
      }
    }
  }
  return out;
}

function walkActions(node: unknown, out: Set<string>): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkActions(child, out);
    return;
  }
  const obj = node as { action?: unknown; submitEvent?: unknown };
  if (typeof obj.action === 'string') out.add(obj.action);
  if (typeof obj.submitEvent === 'string') out.add(obj.submitEvent);
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
function findNestedForm(transition: Transition): { fields: ReadonlyArray<string> } | null {
  for (const effect of transition.effects ?? []) {
    if (!Array.isArray(effect)) continue;
    if (effect[0] !== 'render-ui') continue;
    const found = walkForFormFields(effect[2]);
    if (found !== null) return found;
  }
  return null;
}

function walkForFormFields(node: unknown): { fields: ReadonlyArray<string> } | null {
  if (node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = walkForFormFields(item);
      if (found !== null) return found;
    }
    return null;
  }
  const obj = node as { fields?: unknown; children?: unknown; [k: string]: unknown };
  // Direct hit: an object with a `fields:` array of `{name, ...}`.
  if (Array.isArray(obj.fields)) {
    const names: string[] = [];
    for (const f of obj.fields) {
      if (f !== null && typeof f === 'object' && !Array.isArray(f)) {
        const name = (f as { name?: unknown }).name;
        if (typeof name === 'string') names.push(name);
      }
    }
    if (names.length > 0) return { fields: names };
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
    const obj = payload as { type?: unknown; fields?: unknown };
    if (typeof obj.type !== 'string') continue;

    const pattern = obj.type;
    const isForm = pattern.includes('form') || Array.isArray(obj.fields);
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

/** BFS shortest path from `from` to `to` over the trait's non-INIT transitions. */
function bfsReplayPath(
  trait: Trait,
  from: string,
  to: string,
): Array<{ from: string; event: string; to: string }> | null {
  if (from === to) return [];
  if (trait.stateMachine === undefined) return null;

  const adjacency = new Map<string, ReadonlyArray<Transition>>();
  for (const t of trait.stateMachine.transitions) {
    if (t.event === 'INIT' && t.from === from) continue;
    const list = adjacency.get(t.from);
    adjacency.set(t.from, list === undefined ? [t] : [...list, t]);
  }

  const visited = new Set<string>([from]);
  const queue: Array<{ state: string; path: Array<{ from: string; event: string; to: string }> }> = [
    { state: from, path: [] },
  ];

  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) break;
    const edges = adjacency.get(node.state) ?? [];
    for (const edge of edges) {
      if (visited.has(edge.to)) continue;
      const newPath = [...node.path, { from: edge.from, event: edge.event, to: edge.to }];
      if (edge.to === to) return newPath;
      visited.add(edge.to);
      queue.push({ state: edge.to, path: newPath });
    }
  }

  return null;
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
      out[callName] = callFields.map(toFieldDef);
      continue;
    }

    out[entity.name] = entity.fields.map(toFieldDef);
  }
  return out;
}

function toFieldDef(f: { name: string; type: string; values?: readonly string[] }): EntityFieldDef {
  return {
    name: f.name,
    type: f.type,
    // EntityField.values is readonly per @almadar/core; the consuming
    // EntityFieldDef expects mutable. Spread to bridge — the function
    // doesn't mutate.
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
