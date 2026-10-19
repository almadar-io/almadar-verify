/**
 * `planUserCrudFlow` — the browser half of the CRUD-proof phase. The kernel plans each create, edit and delete chain
 * (the persistor, the overlay trait that drives it, the rows it must leave behind, who runs it, what a blocked delete
 * needs); this adds what only the page shows: whether the open arm really mounts a form whose submit the render
 * produces, the form's field names, the row buttons and their `disabled` expressions.
 *
 * @packageDocumentation
 */

import { isJsonObject, type FieldValue, type JsonValue, type OrbitalSchema, type SExpr, type Trait, type TraitEventListener, type Transition } from '@almadar/core';
import type { CrudChain } from '@almadar/core/kernel-wire';
import type { ExtendedWalkStep, TestKind } from './types.js';
import { establishFromPrecondition } from '../kernel/adapt.js';
import type { KernelPlanner } from '../kernel/kernel-planner.js';
import { eachInlineTrait } from './internal/orbital-walk.js';
import { findAffordanceDisabledExpr } from './internal/affordance-disabled.js';
import { configItemActionEvents, renderActionEventsOf } from '../observer/event-producers.js';

export async function planUserCrudFlow(kernel: KernelPlanner, orbital: OrbitalSchema): Promise<ExtendedWalkStep[]> {
  const planned = await kernel.plan(orbital);
  const traitsByName = indexTraitsByName(orbital);
  const out: ExtendedWalkStep[] = [];
  for (const chain of planned.crudChains) {
    const step = crudStep(chain, orbital, traitsByName);
    if (step !== null) out.push(step);
  }
  return out;
}

const KIND_LABEL: Record<CrudChain['kind'], TestKind> = { create: 'crud-create', edit: 'crud-edit', delete: 'crud-delete' };

function crudStep(chain: CrudChain, orbital: OrbitalSchema, traitsByName: Map<string, Trait>): ExtendedWalkStep | null {
  const sourceTrait = traitsByName.get(chain.sourceTrait);
  const openTransition = sourceTrait?.stateMachine?.transitions.find((t) => t.from === chain.openFrom && t.event === chain.openEvent);
  if (sourceTrait === undefined || openTransition === undefined || !chain.opensOverlay) return null;
  // Only a genuine overlay form whose submit/confirm the SAME render (or the trait's own item actions) produces is a
  // CRUD form; a browse trait's fetch-success arm matches the topology but fires from a fetch, not a click.
  if (!renderActionEventsOf(openTransition).has(chain.submitEvent) && !configItemActionEvents(sourceTrait).has(chain.submitEvent)) return null;

  const inboundListener = (sourceTrait.listens ?? []).find((l) => l.triggers === chain.openEvent);
  const inboundSource = inboundListener !== undefined ? sourceTraitOf(inboundListener) : null;
  const renderingTrait = (inboundSource !== null ? traitsByName.get(inboundSource) : undefined) ?? sourceTrait;

  // The flow clicks the open, then the submit: the source trait settles where a submit arm from `openTo` leads.
  const submitTargets = sourceTrait.stateMachine?.transitions
    .filter((t) => t.from === chain.openTo && t.event === chain.submitEvent)
    .map((t) => t.to) ?? [];

  const step: ExtendedWalkStep = {
    from: chain.openFrom,
    event: chain.openEvent,
    to: chain.openTo,
    ...(submitTargets.length > 0 && { acceptStates: [...new Set(submitTargets)] }),
    guardCase: null,
    payload: {},
    isRepositioning: false,
    traitName: sourceTrait.name,
    triggerKind: 'dom',
    coverageKey: chain.coverageKey,
    testKind: KIND_LABEL[chain.kind],
    expectedRowDelta: { entityName: chain.entity, delta: chain.rowDelta },
    expectedSuccessEvent: chain.successEvent,
    ...(chain.viewer !== undefined && { viewerRequirement: chain.viewer }),
    ...establishFromPrecondition(chain.precondition),
    ...(chain.openAffordanceEvent !== chain.openEvent && { openAffordanceEvent: chain.openAffordanceEvent }),
  };

  if (chain.kind !== 'create') {
    step.isRowAction = configItemActionEvents(renderingTrait).has(chain.openAffordanceEvent);
    const disabled = findAffordanceDisabledExpr(orbital, renderingTrait, chain.openAffordanceEvent);
    if (disabled !== undefined) step.affordanceDisabledExpr = disabled;
    if (chain.requiresRowContext) step.requiresRowContext = true;
  }

  if (chain.kind === 'create' || chain.kind === 'edit') {
    const nested = findNestedForm(openTransition);
    const row = chain.kind === 'edit' ? chain.editEntityRow : chain.entityRow;
    const rowRecord = asRecord(row);
    const names = nested !== null && nested.fields.length > 0
      ? [...nested.fields]
      : Object.keys(rowRecord).filter((k) => k !== 'id' && k !== 'createdAt' && k !== 'updatedAt');
    if (names.length > 0) {
      const submit = asRecord(chain.submitPayload);
      const raw: Record<string, FieldValue> = Object.keys(submit).length > 0
        ? withEditedRow(submit, rowRecord, chain.kind === 'edit')
        : pick(rowRecord, names);
      const fromPayload = flattenFormPayload(raw, names);
      const flat = names.some((n) => fromPayload[n] !== undefined) ? fromPayload : pick(rowRecord, names);
      const formData = Object.keys(flat).length > 0 ? flat : raw;
      step.formData = formData;
      if (Object.keys(flat).length > 0) {
        const content = Object.fromEntries(Object.entries(flat).filter(([k]) => !chain.enumFields.includes(k)));
        step.expectedRowContent = content;
        if (chain.kind === 'edit') {
          const changed = Object.keys(content);
          if (changed.length > 0) step.expectedRowChangedFields = changed;
        }
      }
    }
    step.submitEvent = chain.submitEvent;
  } else {
    step.confirmEvent = chain.submitEvent;
    if (chain.payloadRowShape.length > 0) step.payloadRowShape = chain.payloadRowShape;
    if (chain.avoidReferencedVia !== undefined && chain.avoidReferencedVia.length > 0) step.avoidReferencedVia = chain.avoidReferencedVia;
    if (chain.avoidReferencedByOtherEntities !== undefined && chain.avoidReferencedByOtherEntities.length > 0) {
      step.avoidReferencedByOtherEntities = chain.avoidReferencedByOtherEntities.map((r) => ({ entityName: r.entity, fieldName: r.field }));
    }
    const fallback = chain.deleteEstablishFallback;
    if (fallback !== undefined) {
      step.deleteEstablishFallback = {
        event: fallback.event,
        payload: asRecord(fallback.payload),
        traitName: fallback.trait,
        ...(fallback.viewer !== undefined && { viewerRequirement: fallback.viewer }),
      };
    }
  }
  return step;
}

function asRecord(value: JsonValue): Record<string, FieldValue> {
  return isJsonObject(value) ? value : {};
}

function pick(row: Record<string, FieldValue>, names: ReadonlyArray<string>): Record<string, FieldValue> {
  return Object.fromEntries(names.filter((n) => row[n] !== undefined).map((n) => [n, row[n]]));
}

/** The submit payload with its row-shaped values replaced by the edited row's, so an edit overwrites what it pre-filled. */
function withEditedRow(submit: Record<string, FieldValue>, row: Record<string, FieldValue>, edited: boolean): Record<string, FieldValue> {
  if (!edited) return submit;
  const out: Record<string, FieldValue> = {};
  for (const [key, value] of Object.entries(submit)) {
    out[key] = value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, row[k] ?? v]))
      : value;
  }
  return out;
}

function sourceTraitOf(listener: TraitEventListener): string | null {
  const source = listener.source;
  if (source === undefined) return null;
  if ('kind' in source && source.kind === 'trait' && typeof source.trait === 'string') {
    return source.trait;
  }
  return null;
}

function indexTraitsByName(orbital: OrbitalSchema): Map<string, Trait> {
  const out = new Map<string, Trait>();
  for (const { trait } of eachInlineTrait(orbital)) {
    out.set(trait.name, trait);
  }
  return out;
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

interface NestedForm {
  fields: ReadonlyArray<string>;
  submitEvent?: string;
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
  for (const value of Object.values(obj)) {
    if (typeof value === 'object' && value !== null) {
      const found = walkForFormFields(value);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * `buildMinimalPayload` outputs payload-shaped values keyed by the
 * payload-schema names (e.g. `{ data: { name: ..., description: ... } }`
 * when the schema declares a `data` field of object type). The CRUD
 * observer asserts row CONTENT — keys on the `EntityRow` itself. Walk
 * one level to flatten payload-wrapper keys (`data`) into row-keyed
 * values when present, otherwise return the input as-is.
 */
function flattenFormPayload(
  payload: Record<string, FieldValue>,
  knownFields: ReadonlyArray<string>,
): Record<string, FieldValue> {
  const directHits = knownFields.filter((k) => payload[k] !== undefined);
  if (directHits.length > 0) {
    const out: Record<string, FieldValue> = {};
    for (const k of directHits) out[k] = payload[k];
    return out;
  }
  // Look for a wrapping `data` field with object-typed FieldValue.
  const data = payload.data;
  if (data !== null && typeof data === 'object' && !Array.isArray(data) && !(data instanceof Date)) {
    const obj = data as Record<string, FieldValue>;
    const out: Record<string, FieldValue> = {};
    for (const k of knownFields) {
      if (obj[k] !== undefined) out[k] = obj[k];
    }
    return out;
  }
  return payload;
}
