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
 * target — CREATE establishes the row first. `targetRowId` is left
 * undefined on EDIT/DELETE by this planner; `tick()` resolves the actual
 * target row at dispatch time (C1-V11) — the structurally-first row by
 * default, or (DELETE on a self-referential entity) the first row no
 * other row references via `avoidReferencedVia`.
 *
 * Pure. No Page, no DOM. Reuses
 * `extractPayloadSchema` / `buildFormData` patterns from
 * `plan-data-mutation-tests.ts` and `plan-interaction-tests.ts` to
 * stay grounded in the existing planner conventions.
 *
 * @packageDocumentation
 */

import type {
  Effect,
  FieldValue,
  OrbitalSchema,
  SExpr,
  Trait,
  TraitEventListener,
  Transition,
} from '@almadar/core';
import { SELF_OVERLAY_PATTERN_TYPES } from '@almadar/core';
import type { ExtendedWalkStep, TestKind } from './types.js';
import { eachInlineTrait, findInitialState } from './internal/orbital-walk.js';
import { findPersistKind, isWholeRowField } from './internal/persist-binding.js';
import { planGuardPreconditionPreamble } from './internal/guard-precondition.js';
import { findAffordanceDisabledExpr } from './internal/affordance-disabled.js';
import { collectEntityFields, hasRequiredPayloadFields, payloadFieldSpec } from './internal/payload-synth.js';
import { buildMinimalPayload, declaredValuesOf, type EntityFieldDef, type PayloadFieldSpec } from '../browser/interaction.js';
import { isPortalSlot } from '../browser/portal-slots.js';
import { configItemActionEvents, renderActionEventsOf } from '../observer/wiring-lint.js';
import { deriveViewerRequirement } from './internal/viewer-requirement.js';
import { crossEntityRestrictRelations, selfRelationFieldNames } from './internal/self-relation-fields.js';

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
      const persist = findPersistKind(transition.effects ?? []);
      // A persist with no discoverable `emit.success` can't drive a CRUD
      // step's `expectedSuccessEvent` — same skip `findPersistInfo` used to
      // apply itself (C1-J4, item B: converged onto `findPersistKind`, the
      // ONE effect-shape detector `persist-binding.ts` already owns).
      if (persist === null || persist.successEvent === undefined) continue;
      const bucket = persistsByEntity.get(persist.entity) ?? new Map();
      bucket.set(persist.kind, { kind: persist.kind, entity: persist.entity, successEvent: persist.successEvent, transition });
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
          orbital,
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
          orbital,
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
          orbital,
        });
        if (step !== null) {
          // C1-V15 item C (widened by C1-V17): an entity with a restrict-
          // rule relation pointing at it — SELF (`selfRelationFieldNames`)
          // OR from another entity (`crossEntityRestrictRelations`,
          // std-realtime-chat's `ChannelMember.channel : Channel`) — can
          // legitimately run OUT of unreferenced rows on a real seed. An
          // entity with neither never needs this fallback, and attaching it
          // anyway would just dispatch a needless extra create on every
          // OTHER entity's delete step. Needs the entity's OWN declared
          // `create` too — nothing to fall back to without one.
          if (
            create !== undefined &&
            (selfRelationFieldNames(orbital, entityName).length > 0 ||
              crossEntityRestrictRelations(orbital, entityName).length > 0)
          ) {
            const createPayloadSchema = extractPayloadSchema(persistor, create.transition.event);
            const createPayload = createPayloadSchema.length > 0
              ? (buildMinimalPayload(createPayloadSchema, entityFieldsByName[entityName] ?? []) as Record<string, FieldValue>)
              : {};
            const createViewerRequirement = deriveViewerRequirement(orbital, entityName, 'create');
            step.deleteEstablishFallback = {
              event: create.transition.event,
              payload: createPayload,
              traitName: persistor.name,
              ...(createViewerRequirement !== undefined && { viewerRequirement: createViewerRequirement }),
            };
          }
          result.push(step);
        }
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
  transition: Transition;
}

interface BuildStepInput {
  kind: 'create' | 'edit' | 'delete';
  entityName: string;
  persist: PersistInfo;
  persistor: Trait;
  traitsByName: Map<string, Trait>;
  entityFieldsByName: Record<string, EntityFieldDef[]>;
  /** C1-V10 item 1: the owning schema, needed to derive this step's
   *  {@link deriveViewerRequirement} the SAME way `planDataMutationTests`
   *  does — one shared helper, never a second copy. */
  orbital: OrbitalSchema;
}

function buildCrudStep(input: BuildStepInput): ExtendedWalkStep | null {
  const { kind, entityName, persist, persistor, traitsByName, entityFieldsByName, orbital } = input;

  // Find the persistor's listener whose `triggers` matches this
  // persist transition's event (e.g. listener `triggers: 'DO_CREATE'`
  // for the persistor's `idle -DO_CREATE-> idle` persist transition).
  // The listener's `event` is the user-fired event that propagates via
  // the bus (e.g. 'LIST_ITEM_CREATED'), and `source.trait` names the
  // modal/confirm trait that emits it.
  const triggerEvent = persist.transition.event;

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

  // C1-V18: "first non-INIT transition off the source trait's initial
  // state, landing elsewhere" also structurally matches a BROWSE trait's
  // fetch-success arm (`loading -> browsing`, no user action at all) —
  // `ChannelRail.BrowseItemLoaded` fired a bogus `crud-edit ChannelMember`
  // step, `DirectMessagePicker.BrowseItemLoaded` a bogus `crud-create
  // Channel` step. Only a genuine OVERLAY form (see `isOverlayFormOpen`)
  // whose submit/confirm event is actually produced by that same render
  // (or the source trait's own config item actions) is a real CRUD form;
  // anything else is left to `planDataMutationTests`.
  if (!isOverlayFormOpen(sourceTrait, openTransition, submitEvent)) return null;

  // The DOM affordance that OPENS this modal/confirmation may live
  // upstream when the source trait reaches its open state via a
  // cross-trait listener. For example, std-broadcast-builder's
  // BroadcastDraftDelete declares `listens: [{event: REQUEST_DELETE,
  // triggers: DELETE, source: BroadcastDraftBrowse}]` — the user
  // clicks `action-REQUEST_DELETE` (rendered by Browse's data-grid
  // itemActions), Browse rebroadcasts on its scope, Delete's listener
  // picks it up and dispatches its own DELETE transition.
  //
  // When openEvent (the receiver's transition event) matches a listener's
  // `triggers`, the actual button label is the listener's `event`, not
  // openEvent. Use it for the DOM selector via `openAffordanceEvent`;
  // the coverage key keeps openEvent so the verdict still labels the
  // transition being tested.
  //
  // For create/edit the listener.event often equals openEvent
  // (e.g. Browse.CREATE → Create.CREATE), so the override is a no-op.
  // For delete the upstream is conventionally `REQUEST_DELETE` ≠ `DELETE`.
  const inboundListener = (sourceTrait.listens ?? []).find(
    (l) => l.triggers === openEvent,
  );
  const openAffordanceEvent = inboundListener?.event ?? openEvent;

  // C1-V9 item C: is `openAffordanceEvent` a genuine ROW action, or a
  // plain single button (e.g. a detail page's own action button, reached
  // here via a cross-trait listener the same way a row action is)? A row
  // action is rendered once per row by an `itemActions`/
  // `browseItemActions`-shaped config array on whichever trait ACTUALLY
  // renders the button — the inbound listener's source trait when the
  // open event is rebroadcast cross-trait (a data-grid's itemActions on a
  // Browse trait), else `sourceTrait` itself. Anything else is a DOM
  // click on the page, never row-scoped — `default-dom-trigger.ts` must
  // not require `[data-row-id]` on it, and a miss must not be reported as
  // a missing row affordance.
  const inboundListenerSourceTraitName = inboundListener !== undefined ? sourceTraitOf(inboundListener) : null;
  const renderingTrait =
    (inboundListenerSourceTraitName !== null ? traitsByName.get(inboundListenerSourceTraitName) : undefined)
    ?? sourceTrait;
  const isRowAction = configItemActionEvents(renderingTrait).has(openAffordanceEvent);

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
          .filter((f): f is typeof f & { name: string } =>
            f.name !== undefined && f.name !== 'id' && f.name !== 'createdAt' && f.name !== 'updatedAt',
          )
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
        // Exclude enum/select fields from the content assertion. The rendered
        // form field is typed `string`, so the synthesized value isn't one of
        // the `<select>`'s options; the runtime fill falls back to the first
        // option (so a REQUIRED select isn't left empty, which would block the
        // submit). That fallback value won't equal the synthesized one — the
        // row WAS created with valid data, just don't assert the enum field's
        // specific value. Mirrors the crud-edit enum skip below.
        const enumFieldNames = new Set(
          entityFields.filter((f): f is typeof f & { name: string } => f.name !== undefined && declaredValuesOf(f) !== undefined).map((f) => f.name),
        );
        expectedRowContent = Object.fromEntries(
          Object.entries(flat).filter(([k]) => !enumFieldNames.has(k)),
        ) as Record<string, FieldValue>;
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

  // C1-V10 item 1: the viewer this step's own persist action needs to run
  // as, derived from the target entity's declared access policy — EXACTLY
  // `planDataMutationTests`'s own call (`persist.kind` is already
  // 'create'|'update'|'delete', the same vocabulary
  // `deriveViewerRequirement` expects). `tick()` already resolves this
  // generically for every planner (switch persona before dispatch, stamp
  // create's owner field into `step.payload`, restore after) — no new
  // driver/tick logic needed. For edit/delete the owner lookup reads
  // whichever row `tick()`'s own C1-V11 row resolution picked (the SAME
  // row `avoidReferencedVia` steers `pickBindableRow` toward, or the
  // structurally-first row when unset) — one picked row drives the DOM
  // click, the viewer switch, AND the persist payload, so they never
  // disagree.
  const viewerRequirement = deriveViewerRequirement(orbital, entityName, persist.kind);
  if (viewerRequirement !== undefined) {
    step.viewerRequirement = viewerRequirement;
  }

  // C1-V15 item A: this step dispatches the OPEN affordance on `sourceTrait`
  // (the modal/confirmation), never the persistor directly — the guarded
  // `persist.transition` (on `persistor`) only fires as a CASCADE from this
  // step's submit/confirm click. A guard precondition a sibling trait
  // establishes is exactly as unreachable here as it is for
  // `planDataMutationTests`'s own direct-dispatch steps — same detector,
  // attached to THIS step (`sourceTrait`'s own open/submit chain) instead,
  // since that's the actual dispatch this planner drives.
  if (persist.transition.guard !== undefined) {
    const guardPlan = planGuardPreconditionPreamble(
      orbital, persistor, persist.transition, persist.transition.from, entityFieldsByName,
    );
    if (guardPlan.establishesRow !== undefined) {
      step.establishesRow = guardPlan.establishesRow;
    } else if (guardPlan.guardPreconditionUnreachable !== undefined) {
      step.unreachableRowReason = guardPlan.guardPreconditionUnreachable;
    }
  }

  // Only set the affordance override when it actually differs — keeps
  // step.event-only paths working unchanged for cases like
  // Browse.CREATE → Create.CREATE where the listener.event matches the
  // receiver's transition event.
  if (openAffordanceEvent !== openEvent) {
    step.openAffordanceEvent = openAffordanceEvent;
  }

  // C1-V9 item C: only edit/delete are ever row-scoped in the first
  // place (`default-dom-trigger.ts`'s `needsRow` never considers create).
  if (kind === 'edit' || kind === 'delete') {
    step.isRowAction = isRowAction;

    // C1-V15 item B: the SAME `renderingTrait` C1-V9 item C already
    // resolved ("whichever trait actually paints the button") is where the
    // affordance's OWN `disabled` expression lives too — read once here so
    // `tick()`'s row resolution can exclude a candidate row the affordance
    // would silently ignore (a structural no-op click, DOM ✓ / cascade ✗).
    const disabled = findAffordanceDisabledExpr(orbital, renderingTrait, openAffordanceEvent);
    if (disabled !== undefined) {
      step.affordanceDisabledExpr = disabled;
    }
  }

  // I-23: when the OPEN event declares required payload fields, a bare `{}`
  // bus fallback is a guaranteed payload-validation rejection — mark the
  // step so the kernel skips honestly instead of dispatching it. Edit and
  // delete need row context; create's affordance is a toolbar button.
  if (kind === 'edit' || kind === 'delete') {
    const openEventSchema = extractPayloadSchema(sourceTrait, openEvent);
    if (hasRequiredPayloadFields(openEventSchema)) {
      step.requiresRowContext = true;
    }
  }

  if (kind === 'create' || kind === 'edit') {
    if (formData !== undefined) step.formData = formData;
    if (expectedRowContent !== undefined) step.expectedRowContent = expectedRowContent;
    step.submitEvent = submitEvent;
    if (kind === 'edit') {
      // Vocabulary fields get excluded from the changed-field expectation, and
      // the exclusion is now load-bearing rather than defensive. It used to be
      // "seeders pick a random arrayElement, so enum fields collide ~1/N of the
      // time". Seeding is deterministic now: row 1 is always `values[0]`, and
      // `buildMinimalPayload` also picks `values[0]` — so an edit to a
      // vocabulary field on row 1 collides EVERY time and can never appear in
      // `fieldsChanged`. The row WAS still edited (other fields changed), so
      // dropping this exclusion would introduce a deterministic false negative.
      const enumFieldNames = new Set(
        entityFields.filter((f): f is typeof f & { name: string } => f.name !== undefined && declaredValuesOf(f) !== undefined).map((f) => f.name),
      );
      const changed = expectedRowContent !== undefined
        ? Object.keys(expectedRowContent).filter((k) => !enumFieldNames.has(k))
        : [];
      if (changed.length > 0) step.expectedRowChangedFields = changed;
    }
  } else {
    // crud-delete — second click is the confirmation affordance.
    step.confirmEvent = submitEvent;
    // The receiver's open event declares its payload (std-delete:
    // `id` required + `row: <Entity>` whose guard is `"@payload.row"`).
    // When the DOM has no delete affordance, the trigger dispatches the
    // event itself and needs a real row to fill those fields — give it
    // the schema-derived shape (entity-typed fields take the whole row,
    // the rest take `row[name]`). Empty schema → trigger's `{id}` base.
    //
    // `wholeRow` reads the lowering-stamped `entity` marker via
    // {@link isWholeRowField} (persist-binding.ts's ONE owner for this
    // question, C1-J3 item B), not `type` (`type` is `"object"`/`"[object]"`
    // for ANY flattened entity OR anonymous struct field — comparing it to
    // `entityName` was coincidentally right only when the field happened to
    // be typed exactly `entityName` as a bare string, which flattening
    // never produces). A registry `.orb` emitted BEFORE the marker existed
    // carries no `entity` field, so `wholeRow` is deterministically
    // `false` for it — not a fallback, the honest absence of data.
    const openSchema = extractPayloadSchema(sourceTrait, openEvent);
    if (openSchema.length > 0) {
      step.payloadRowShape = openSchema.map((f) => ({
        name: f.name,
        wholeRow: isWholeRowField(f, entityName),
      }));
    }

    // C1-V11: `targetRowId` is left undefined (the driver picks the
    // structurally-first row by default) — for a self-referential entity
    // the mock seeder's tree shape makes that default row a root with
    // children EVERY time, which an `onDelete: restrict` rule rejects
    // regardless of viewer. Attach the fields to avoid so `tick()` can
    // pick a genuinely deletable row instead. Undefined (not an empty
    // array) when the entity declares no restrict-rule self-relation —
    // `tick()` treats that the same as "no avoidance needed".
    const avoidReferencedVia = selfRelationFieldNames(orbital, entityName);
    if (avoidReferencedVia.length > 0) {
      step.avoidReferencedVia = avoidReferencedVia;
    }
    // C1-V17: cross-entity restrict relations block a delete exactly like a
    // self-relation does — `enforceOnDeleteRules` scans every entity, not
    // just this one.
    const crossEntity = crossEntityRestrictRelations(orbital, entityName);
    if (crossEntity.length > 0) {
      step.avoidReferencedByOtherEntities = crossEntity;
    }
  }

  return step;
}

function deltaFor(kind: 'create' | 'edit' | 'delete'): number {
  if (kind === 'create') return 1;
  if (kind === 'delete') return -1;
  return 0;
}

/**
 * C1-V18: is `openTransition` a genuine OVERLAY form's open affordance —
 * one that renders either into a non-`main` portal slot (`modal` /
 * `drawer` / `overlay` / `center` / …, `PORTAL_SLOTS` minus `main`/
 * `sidebar`) OR a SELF-overlay pattern declared in `main`
 * (`SELF_OVERLAY_PATTERN_TYPES` — `modal`/`confirm-dialog` portal
 * themselves out of the main flow at render time regardless of the
 * literal slot the `.lolo` source targets) — AND does `submitEvent`
 * actually originate from that SAME render, or from the source trait's
 * own declared `itemActions`/`browseItemActions`-shaped config? A Browse
 * trait's fetch-success arm (`loading -> browsing`, rendering an
 * `entity-table` into `main`) structurally matches "first non-INIT
 * transition off the source trait's initial state" exactly the way a real
 * modal's OPEN arm does, but fires from a FETCH, not a click —
 * `submitEvent` there (`UNREAD_CLEARED`, `START_DM`, …) is produced by
 * some OTHER affordance entirely, never by this transition's own render.
 */
function isOverlayFormOpen(sourceTrait: Trait, openTransition: Transition, submitEvent: string): boolean {
  if (!opensOverlayPattern(openTransition.effects)) return false;
  if (renderActionEventsOf(openTransition).has(submitEvent)) return true;
  return configItemActionEvents(sourceTrait).has(submitEvent);
}

function opensOverlayPattern(effects: ReadonlyArray<Effect> | undefined): boolean {
  return (effects ?? []).some((effect) => rendersOverlayPattern(effect));
}

function rendersOverlayPattern(node: Effect | SExpr): boolean {
  if (!Array.isArray(node)) return false;
  const nodes = node as readonly SExpr[];
  if (nodes[0] === 'render-ui' && nodes.length >= 3 && nodes[2] != null) {
    const slot = nodes[1];
    if (typeof slot === 'string' && slot !== 'main' && slot !== 'sidebar' && isPortalSlot(slot)) return true;
    const payload = nodes[2];
    if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
      const patternType = (payload as Readonly<Record<string, SExpr>>)['type'];
      if (typeof patternType === 'string' && SELF_OVERLAY_PATTERN_TYPES.has(patternType)) return true;
    }
  }
  return nodes.some((child) => rendersOverlayPattern(child));
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
): PayloadFieldSpec[] {
  const event = trait.stateMachine?.events.find((e) => e.key === eventKey);
  if (event === undefined || event.payloadSchema === undefined) return [];
  return event.payloadSchema.map(payloadFieldSpec);
}

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

