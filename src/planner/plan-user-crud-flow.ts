/**
 * `planUserCrudFlow` — pure planner that produces ExtendedWalkSteps
 * for the v3.7.0 CRUD-proof phase.
 *
 * For each `(linkedEntity, persistorTrait)` pair in the orbital, walks
 * the persistor's persist effects and the persistor's `listens` block
 * to discover the (modal | confirmation) trait that triggers each
 * persist. Generates one ordered chain per entity:
 *
 *   1. `crud-create` — click `[data-testid="action-<openCreate>"]`,
 *      fill the form-section that opens with synthesized field values,
 *      click `[data-testid="action-<submitCreate>"]`. Verifies emit +
 *      entity diff (added row content matches the form payload) + DOM
 *      list +1 row.
 *   2. `crud-edit` — click the first
 *      `[data-testid="action-<openEdit>"][data-row-id]` button, fill
 *      the form (overwriting pre-fill) with new values, click submit.
 *      Verifies emit + entity diff (one row changed, fields match) +
 *      DOM list +0.
 *   3. `crud-delete` — click the first
 *      `[data-testid="action-<openDelete>"][data-row-id]` button, then
 *      click `[data-testid="action-<confirmDelete>"]`. Verifies emit +
 *      entity diff (one row removed) + DOM list -1.
 *
 * The chain is ordered so EDIT/DELETE always have at least one row to
 * target — CREATE establishes the row first. The driver picks the
 * first `[data-row-id]` deterministically (structural position), so
 * `targetRowId` is left undefined on EDIT/DELETE.
 *
 * Pure. No Page, no DOM. Reuses
 * `extractPayloadSchema` / `buildFormData` patterns from
 * `plan-data-mutation-tests.ts` and `plan-interaction-tests.ts` to
 * stay grounded in the existing planner conventions.
 *
 * @packageDocumentation
 */

import type {
  FieldValue,
  OrbitalSchema,
  Trait,
  TraitEventListener,
  Transition,
} from '@almadar/core';
import { isEntityReference, isEntityCall } from '@almadar/core';
import type { ExtendedWalkStep, TestKind } from './types.js';
import { eachInlineTrait, findInitialState } from './internal/orbital-walk.js';
import { buildMinimalPayload, type EntityFieldDef } from '../browser/interaction.js';

export function planUserCrudFlow(orbital: OrbitalSchema): ExtendedWalkStep[] {
  const result: ExtendedWalkStep[] = [];
  const entityFieldsByName = collectEntityFields(orbital);
  const traitsByName = indexTraitsByName(orbital);

  for (const { trait: persistor } of eachInlineTrait(orbital)) {
    if (persistor.stateMachine === undefined) continue;
    const persistInitial = findInitialState(persistor.stateMachine);
    if (persistInitial === null) continue;

    // Bucket persists per entity so we order create → edit → delete.
    const persistsByEntity = new Map<string, Map<'create' | 'update' | 'delete', PersistInfo>>();

    for (const transition of persistor.stateMachine.transitions) {
      if (transition.event === 'INIT') continue;
      const persist = findPersistInfo(transition);
      if (persist === null) continue;
      const bucket = persistsByEntity.get(persist.entity) ?? new Map();
      bucket.set(persist.kind, { ...persist, transition });
      persistsByEntity.set(persist.entity, bucket);
    }

    for (const [entityName, persists] of persistsByEntity) {
      const create = persists.get('create');
      const update = persists.get('update');
      const del = persists.get('delete');

      if (create !== undefined) {
        const step = buildCrudStep({
          kind: 'create',
          entityName,
          persist: create,
          persistor,
          traitsByName,
          entityFieldsByName,
        });
        if (step !== null) result.push(step);
      }

      if (update !== undefined) {
        const step = buildCrudStep({
          kind: 'edit',
          entityName,
          persist: update,
          persistor,
          traitsByName,
          entityFieldsByName,
        });
        if (step !== null) result.push(step);
      }

      if (del !== undefined) {
        const step = buildCrudStep({
          kind: 'delete',
          entityName,
          persist: del,
          persistor,
          traitsByName,
          entityFieldsByName,
        });
        if (step !== null) result.push(step);
      }
    }
  }

  return result;
}

// ── internal ─────────────────────────────────────────────────────────

interface PersistInfo {
  kind: 'create' | 'update' | 'delete';
  entity: string;
  successEvent: string;
  /** The persistor's listens-block event that triggers this persist
   *  transition (e.g. `LIST_ITEM_CREATED`). The user-flow's submit
   *  click fires THIS event from the modal. */
  listenEvent: string | undefined;
  transition: Transition;
}

interface BuildStepInput {
  kind: 'create' | 'edit' | 'delete';
  entityName: string;
  persist: PersistInfo;
  persistor: Trait;
  traitsByName: Map<string, Trait>;
  entityFieldsByName: Record<string, EntityFieldDef[]>;
}

function buildCrudStep(input: BuildStepInput): ExtendedWalkStep | null {
  const { kind, entityName, persist, persistor, traitsByName, entityFieldsByName } = input;

  // Find the persistor's listener whose `triggers` matches this
  // persist transition's event (e.g. listener `triggers: 'DO_CREATE'`
  // for the persistor's `idle -DO_CREATE-> idle` persist transition).
  // The listener's `event` is the user-fired event that propagates via
  // the bus (e.g. 'LIST_ITEM_CREATED'), and `source.trait` names the
  // modal/confirm trait that emits it.
  const triggerEvent = persist.listenEvent;
  if (triggerEvent === undefined) return null;

  const listener = (persistor.listens ?? []).find((l) => l.triggers === triggerEvent);
  if (listener === undefined) return null;
  const sourceTraitName = sourceTraitOf(listener);
  if (sourceTraitName === null) return null;
  const listenEvent = listener.event;

  const sourceTrait = traitsByName.get(sourceTraitName);
  if (sourceTrait === undefined || sourceTrait.stateMachine === undefined) return null;

  const sourceInitial = findInitialState(sourceTrait.stateMachine);
  if (sourceInitial === null) return null;

  // The source trait is one of:
  //   - Modal: closed -OPEN(renamed CREATE/EDIT)-> open, open -SAVE(renamed LIST_ITEM_X)-> closed
  //   - Confirmation: idle -REQUEST(renamed DELETE)-> confirming, confirming -CONFIRM(renamed CONFIRM_DELETE)-> idle
  //
  // The OPEN affordance is the transition whose `to` lands on a
  // non-initial state. The SAVE/CONFIRM affordance is the transition
  // FROM that non-initial state whose event matches `listenEvent`.

  const openTransition = sourceTrait.stateMachine.transitions.find(
    (t) => t.from === sourceInitial && t.to !== sourceInitial && t.event !== 'INIT',
  );
  if (openTransition === undefined) return null;

  // Locate the SAVE/CONFIRM transition (the one that fires listenEvent).
  const submitOrConfirmTransition = sourceTrait.stateMachine.transitions.find(
    (t) => t.from === openTransition.to && t.event === listenEvent,
  );
  if (submitOrConfirmTransition === undefined) return null;

  const openEvent = openTransition.event;
  const submitEvent = submitOrConfirmTransition.event;

  // Synthesize the form payload for create/edit. Edit overwrites the
  // pre-filled row, so its content is distinct from create's.
  const payloadSchema = extractPayloadSchema(sourceTrait, listenEvent);
  const linkedEntity = sourceTrait.linkedEntity ?? entityName;
  const entityFields = entityFieldsByName[linkedEntity] ?? entityFieldsByName[entityName] ?? [];

  let formData: Record<string, FieldValue> | undefined;
  let expectedRowContent: Record<string, FieldValue> | undefined;

  if (kind === 'create' || kind === 'edit') {
    // Find the form-section nested in the open transition's render-ui.
    const nestedForm = findNestedForm(openTransition);
    const synthSchema = nestedForm !== null && nestedForm.fields.length > 0
      ? nestedForm.fields.map((n) => ({ name: n, type: 'string' as const }))
      : entityFields
          .filter((f) => f.name !== 'id' && f.name !== 'createdAt' && f.name !== 'updatedAt')
          .map((f) => ({ name: f.name, type: f.type }));

    if (synthSchema.length > 0) {
      const raw = payloadSchema.length > 0
        ? buildMinimalPayload(payloadSchema, [...entityFields])
        : buildMinimalPayload(synthSchema, [...entityFields]);
      // `raw` is shaped to match the listens block — for std-list edit
      // that's `{ data : ListItem }`, so `raw = { data: <row> }`. The
      // form's submit handler emits the wrapped shape, but
      // fillFormFieldsFromMap needs FLAT keys (one per rendered input)
      // to match `[data-field-name="<name>"]` selectors. Confirmed via
      // `[almadar:verify:dom] dom:fill:enter { expectedKeys: 'data' }`
      // logs on the std-list crud-edit step before this distinction
      // existed: the driver tried to fill a non-existent `data` field
      // and skipped every actual form field.
      const flat = flattenFormPayload(raw as Record<string, FieldValue>, synthSchema.map((s) => s.name));
      // For the form-fill side: prefer the flat shape if available
      // (matches rendered field names); fall back to the raw payload-
      // shape for backward compatibility with payloadSchemas that
      // already produce flat keys.
      formData = Object.keys(flat).length > 0
        ? flat
        : (raw as Record<string, FieldValue>);
      if (Object.keys(flat).length > 0) {
        expectedRowContent = flat;
      }
    }
  }

  const testKind: TestKind =
    kind === 'create' ? 'crud-create' :
    kind === 'edit'   ? 'crud-edit'   :
                        'crud-delete';

  const step: ExtendedWalkStep = {
    from: openTransition.from,
    event: openEvent,
    to: openTransition.to,
    guardCase: null,
    payload: {},
    isRepositioning: false,
    traitName: sourceTrait.name,
    triggerKind: 'dom',
    coverageKey: `${sourceTrait.name}:${openTransition.from}+${openEvent}->${openTransition.to}[${testKind}]`,
    testKind,
    expectedRowDelta: { entityName, delta: deltaFor(kind) },
    expectedSuccessEvent: persist.successEvent,
  };

  if (kind === 'create' || kind === 'edit') {
    if (formData !== undefined) step.formData = formData;
    if (expectedRowContent !== undefined) step.expectedRowContent = expectedRowContent;
    step.submitEvent = submitEvent;
    if (kind === 'edit') {
      // Field names whose values changed from the pre-fill. Same as the
      // form-data keys.
      const changed = expectedRowContent !== undefined
        ? Object.keys(expectedRowContent)
        : [];
      if (changed.length > 0) step.expectedRowChangedFields = changed;
    }
  } else {
    // crud-delete — second click is the confirmation affordance.
    step.confirmEvent = submitEvent;
  }

  return step;
}

function findPersistInfo(transition: Transition): { kind: 'create' | 'update' | 'delete'; entity: string; successEvent: string; listenEvent: string | undefined } | null {
  for (const effect of transition.effects ?? []) {
    if (!Array.isArray(effect)) continue;
    if (effect[0] !== 'persist') continue;
    const kind = effect[1];
    if (kind !== 'create' && kind !== 'update' && kind !== 'delete') continue;
    if (typeof effect[2] !== 'string') continue;

    let successEvent: string | undefined;
    for (let i = 3; i < effect.length; i++) {
      const arg = effect[i];
      if (arg === null || typeof arg !== 'object' || Array.isArray(arg)) continue;
      const emit = (arg as { emit?: { success?: unknown } }).emit;
      if (emit === undefined) continue;
      if (typeof emit.success === 'string' && emit.success.length > 0) {
        successEvent = emit.success;
        break;
      }
    }
    if (successEvent === undefined) return null;

    return {
      kind,
      entity: effect[2],
      successEvent,
      // The listen event that triggered this persist's transition is
      // `transition.event` itself — the listener block's `triggers`
      // points to that event key on the persistor.
      listenEvent: transition.event,
    };
  }
  return null;
}

function deltaFor(kind: 'create' | 'edit' | 'delete'): number {
  if (kind === 'create') return 1;
  if (kind === 'delete') return -1;
  return 0;
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

interface NestedForm {
  fields: ReadonlyArray<string>;
  submitEvent?: string;
}

function findNestedForm(transition: Transition): NestedForm | null {
  for (const effect of transition.effects ?? []) {
    if (!Array.isArray(effect)) continue;
    if (effect[0] !== 'render-ui') continue;
    const found = walkForFormFields(effect[2]);
    if (found !== null) return found;
  }
  return null;
}

function walkForFormFields(node: unknown): NestedForm | null {
  if (node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = walkForFormFields(item);
      if (found !== null) return found;
    }
    return null;
  }
  const obj = node as { fields?: unknown; submitEvent?: unknown; [k: string]: unknown };
  if (Array.isArray(obj.fields)) {
    const names: string[] = [];
    for (const f of obj.fields) {
      if (typeof f === 'string' && f.length > 0) {
        names.push(f);
      } else if (f !== null && typeof f === 'object' && !Array.isArray(f)) {
        const name = (f as { name?: unknown }).name;
        if (typeof name === 'string') names.push(name);
      }
    }
    if (names.length > 0) {
      return {
        fields: names,
        ...(typeof obj.submitEvent === 'string' && { submitEvent: obj.submitEvent }),
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

function collectEntityFields(orbital: OrbitalSchema): Record<string, EntityFieldDef[]> {
  const out: Record<string, EntityFieldDef[]> = {};
  for (const orb of orbital.orbitals) {
    const entityRef = orb.entity;
    if (entityRef === undefined) continue;
    if (isEntityReference(entityRef) || isEntityCall(entityRef)) continue;
    const fields = entityRef.fields ?? [];
    out[entityRef.name] = fields
      .filter((f): f is typeof f & { name: string } =>
        typeof f.name === 'string' && f.name.length > 0,
      )
      .map((f) => ({
        name: f.name,
        type: f.type,
        values: f.values !== undefined ? [...f.values] : undefined,
      }));
  }
  return out;
}
