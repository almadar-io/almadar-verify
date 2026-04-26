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

  for (const { trait } of eachInlineTrait(orbital)) {
    if (trait.stateMachine === undefined) continue;
    const initial = findInitialState(trait.stateMachine);
    if (initial === null) continue;

    for (const transition of trait.stateMachine.transitions) {
      if (transition.event === 'INIT') continue;

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

      // Build form data when the rendered pattern is a form.
      const payloadSchema = extractPayloadSchema(trait, transition.event);
      const linkedEntity = trait.linkedEntity;
      const formData =
        renderTarget.isForm && payloadSchema.length > 0
          ? buildFormData(payloadSchema, linkedEntity, entityFieldsByName)
          : undefined;

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
