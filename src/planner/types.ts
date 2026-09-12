/**
 * Planner type contracts.
 *
 * Planners are pure functions that turn an `.orb`-derived trait shape
 * (transitions + initial state + emit declarations) into an ordered
 * list of `ExtendedWalkStep`s. The driver then executes those steps
 * one-by-one via `tick()`, producing a `Frame[]` stream.
 *
 * @packageDocumentation
 */

import type { FieldValue, Orbital, OrbitalSchema, ReplayStep, WalkStep } from '@almadar/core';
import type { TriggerKind } from '../frame/types.js';
import type { TraitWalkConfig } from '../engine/types.js';
import type { EmitDeclaration } from '../browser/catalog-probes.js';
import type { EntityFieldDef } from '../browser/interaction.js';
import type { ViewerRequirement } from './internal/viewer-requirement.js';
import type { AffordanceDisabledExpr } from './internal/affordance-disabled.js';

/**
 * v3.14.0 — explicit per-transition variant tag. `planWalk` emits up to
 * three variants per transition so the validator/guard/state-machine
 * gets exercised on both the rejection and success paths:
 *   - `malformed`: empty payload, expect API-boundary validator to
 *     reject (frame.serverResponse.success = false, state holds).
 *   - `success`: synthesized payload from `event.payloadSchema`,
 *     expect transition to fire end-to-end. For guarded transitions
 *     this also means the guard is satisfied (we merge in
 *     `buildGuardPayloads.pass`).
 *   - `guard-fail`: synthesized payload merged with the guard-fail
 *     payload, expect guard to reject (state holds, no effects fire).
 *
 * Pre-v3.14 planWalk had only the `pass`/`fail` guard cases via
 * `WalkStep.guardCase` and emitted a single empty-payload step for
 * unguarded transitions, which masked the validator's reject path
 * entirely. Encoded as a separate field so observers that want to
 * branch on it can read `frame.cause.payloadCase` directly without
 * overloading `guardCase`'s pass/fail/null semantics.
 */
export type PayloadCase = 'malformed' | 'success' | 'guard-fail';

/**
 * Tag used by observers to group verdicts produced by the v3.0.0
 * planner extensions. Steps emitted by the base `planWalk` /
 * `planInitCredit` / `planEmitSweep` / `planReplayTo` planners leave
 * this undefined.
 */
export type TestKind =
  | 'interaction'
  | 'data-mutation'
  | 'contract'
  | 'click-path'
  | 'crud-create'
  | 'crud-edit'
  | 'crud-delete';

/**
 * Per-entity row-count delta the observer expects after a step
 * settles. Used by `assertDataMutation` for CRUD verification.
 */
export interface ExpectedRowDelta {
  entityName: string;
  /** Positive on create, negative on delete, zero on update. */
  delta: number;
}

/**
 * `WalkStep` decorated with the kernel-level metadata observers and the
 * driver need:
 *   - `triggerKind`: how this step gets fired (bus, dom, auto-init, replay)
 *   - `coverageKey`: the same key `frame/keyOf(cause)` produces, computed
 *     up front so coverage's denominator never has to re-derive it
 *   - v3.0.0 fields (all optional): declarative metadata the planners
 *     attach so observers and `Driver.triggerDOM` can do their work
 *     without re-reading the schema or re-querying the runtime.
 */
export interface ExtendedWalkStep extends WalkStep {
  triggerKind: TriggerKind;
  /** Stable `${trait}:${from}+${event}->${to}${guardSuffix}`. Single source of truth for coverage. */
  coverageKey: string;
  /** The trait this step targets (carried so the kernel can route the step). */
  traitName: string;

  // ── v3.0.0 declarative fields (optional, populated by the lifted planners) ──

  /**
   * When set together with `triggerKind === 'dom'`, `Driver.triggerDOM`
   * fills the form's matching fields with these values before clicking
   * submit. Keys are field names; values are core `FieldValue`s.
   */
  formData?: Record<string, FieldValue>;

  /**
   * Pattern observer expects to be mounted in the next frame's
   * `domSnapshot.portals` after this step settles. Used by
   * `assertInteractionPattern` to verify "did the modal open?" without
   * re-querying the DOM.
   */
  expectedPattern?: string;

  /**
   * Per-entity row-count delta observer expects after this step's
   * settle. Used by `assertDataMutation` for CRUD verification.
   */
  expectedRowDelta?: ExpectedRowDelta;

  /**
   * v3.2.0: success-emit event key extracted from the persist / fetch /
   * call-service / ref effect's `{ emit: { success: "X" } }` block.
   * `assertDataMutation` uses this as the canonical signal that the
   * effect ran successfully — checks
   * `frame.serverResponse.emittedEvents.includes(this)`. Independent
   * from `expectedRowDelta` so mock-backend acks that don't update the
   * store still pass the gate.
   */
  expectedSuccessEvent?: string;

  /**
   * v3.2.3: when an interaction-test step opens a form (e.g. a modal
   * containing a form-section), this is the form's `submitEvent` — the
   * event key dispatched when the user clicks the Save button. The
   * driver targets `[data-testid="action-<submitEvent>"]` to find and
   * click it. Extracted by the planner from the form-section's render-ui
   * config. No fallback heuristics — if the rendered button doesn't
   * carry the attribute, that's a UI bug to fix at source.
   */
  submitEvent?: string;

  /**
   * v4.0.4 (V-5 fix): the event name of the upstream DOM affordance
   * that fires the cross-trait listen-fanout opening this step's
   * modal/confirmation. Set by `planUserCrudFlow` when the source trait
   * reaches its open state via a `listens` entry — e.g. Delete's
   * `idle -DELETE-> confirming` is fired by Browse rebroadcasting
   * `REQUEST_DELETE` (Browse.data-grid itemAction → Delete.listens →
   * Delete.DELETE). The data-grid renders `action-REQUEST_DELETE`,
   * NOT `action-DELETE`; the driver targets
   * `[data-testid="action-<openAffordanceEvent>"]` to click the
   * upstream button. When undefined, the driver falls back to
   * `step.event` (the receiver's transition event) — correct for
   * cases where listener.event === listener.triggers (e.g. CREATE).
   */
  openAffordanceEvent?: string;

  /**
   * Steps to replay first to reach this step's `from` state. The
   * planner expands these inline so each becomes its own
   * `triggerKind: 'replay'` Frame in the kernel walk; consumers should
   * treat this field as advisory metadata, not as a directive `tick`
   * acts on directly. Pre-populated from `@almadar/core`'s `ReplayStep`.
   */
  replayPath?: ReadonlyArray<ReplayStep>;

  /**
   * Tag used by observers to group verdicts. Steps from the base
   * planners (planWalk, planInitCredit, planEmitSweep, planReplayTo)
   * leave this undefined; v3.0.0 planner extensions stamp it with the
   * matching kind.
   */
  testKind?: TestKind;

  // ── v3.7.0 CRUD-flow declarative fields (optional, populated by
  //     planUserCrudFlow) ───────────────────────────────────────────────

  /**
   * v3.7.0: form payload the observer expects to find on the row that
   * was added (`crud-create`) or mutated (`crud-edit`). Each key is a
   * field name on the linked entity; each value is the core
   * `FieldValue` the form was submitted with. `assertCrudFlow` asserts
   * the row's after-state matches every key/value pair.
   */
  expectedRowContent?: Record<string, FieldValue>;

  /**
   * v3.7.0: for `crud-edit`, the field names the observer expects to
   * appear in `EntityRowChange.fieldsChanged`. Lets the observer
   * distinguish "row changed in the right way" from "row changed in
   * some unrelated way".
   */
  expectedRowChangedFields?: ReadonlyArray<string>;

  /**
   * v3.7.0: for `crud-edit` / `crud-delete`, the row id this step
   * targets. The DOM trigger uses
   * `[data-testid="action-<event>"][data-row-id="<id>"]` to find the
   * specific affordance on that row. Single deterministic tag per row.
   * When undefined for a crud-edit/delete step, the trigger picks the
   * first `[data-row-id]` affordance in the rendered list (deterministic
   * structural position — not a heuristic).
   */
  targetRowId?: string;

  /**
   * v3.7.1: for `crud-delete`, the shape the DOM trigger fills from a
   * real entity row when no delete affordance exists and it must
   * dispatch the event itself. Derived from the receiver event's
   * `payloadSchema`: fields whose declared type is the persisted
   * entity's name take the WHOLE row object (e.g. `row: Task` — the
   * std-delete guard `"@payload.row"` requires it); every other field
   * takes `row[<name>]` (so `id: string` gets `row.id`). Without this
   * the trigger dispatched `{id}` and guards referencing the row
   * silently held the transition.
   */
  payloadRowShape?: ReadonlyArray<{ name: string; wholeRow: boolean }>;

  /**
   * I-23: the step's open event declares REQUIRED payload fields, so the
   * kernel's bare `{}` bus fallback would be rejected by payload
   * validation every time. When the DOM trigger finds no affordance, the
   * kernel SKIPS the dispatch (honest informational skip) instead of
   * bare-dispatching a guaranteed rejection.
   */
  requiresRowContext?: boolean;

  /**
   * v3.7.0: for `crud-delete`, the affordance event the driver clicks
   * AFTER the initial open click to actually fire the persist. This is
   * the confirmation modal's CONFIRM affordance (e.g. `CONFIRM_DELETE`).
   * For `crud-create` / `crud-edit` use `submitEvent` instead.
   */
  confirmEvent?: string;

  /**
   * v3.14.0: per-transition variant tag from `planWalk`. See
   * `PayloadCase` jsdoc. Undefined for steps emitted by extension
   * planners (`planInteractionTests`, `planUserCrudFlow`, etc.) that
   * don't fan out into malformed/success/guard-fail variants.
   */
  payloadCase?: PayloadCase;

  /**
   * Settled states the runtime may legitimately land in after this step,
   * beyond `to`. When `to` is a *transient* state — one whose entry effect
   * synchronously emits an event that transitions out (e.g. `loading`'s
   * `fetch` emits `CartItemLoaded` → `browsing`) — the runtime auto-advances
   * past `to` before the kernel can observe it. `planWalk` sets this to the
   * transient closure of `to` so `decideAccepted` credits any reachable
   * settled state. Undefined → only `to` is accepted (the normal case).
   */
  acceptStates?: readonly string[];

  /**
   * Tick-wait steps (`triggerKind: 'tick'`): wall-clock milliseconds the
   * kernel waits before settling and snapshotting, sourced from the
   * declared `TraitTick.interval`. Undefined on every other step kind.
   */
  waitMs?: number;

  /**
   * Guarded-variant steps only: `false` when the transition's guard
   * binds `@entity.*` / `@config.*` (not `@payload.*`), so the planner's
   * synthesized pass/fail payload cannot steer the outcome and
   * `assertGuardParity` must skip the frame. Undefined / `true` means
   * the guard is payload-steerable (the normal case).
   */
  guardSteerable?: boolean;

  /**
   * Guard-fail variants only: the OTHER declared targets of this step's
   * `(from, event)` pair. When complementary guarded arms share an event,
   * the fail-probe payload for one arm legitimately fires a sibling arm —
   * `decideAccepted` credits landing on any of these instead of
   * hard-requiring the state to hold. Undefined when the arm has no
   * siblings (the normal single-arm case).
   */
  guardSiblingTargets?: readonly string[];

  /**
   * The step's transition carries a `navigate` effect: firing it can swap
   * the page and unmount the trait, so a `null` post-dispatch state read
   * is legitimate (`collectDispatchErrors` accepts it instead of flagging
   * a stateless dispatch). Stamped by `planWalk` from
   * `WalkTransition.navigates`.
   */
  navigates?: boolean;

  /**
   * C1-V8 (R-PERSIST-NO-ROW-KEY-SILENT-SUCCESS, the `from === initialState`
   * gap): a hop `tick()` must dispatch IMMEDIATELY BEFORE this step's own
   * event, in the SAME live trait instance — no intervening `driver.reset`
   * — so the row this step's `persist update|delete` writes to actually
   * exists (and `@entity.id` is bound) when the write fires.
   *
   * Only needed when `runVerification`'s own state-topology reconcile
   * preamble (`planReplayTo({ targetState: step.from })`, dispatched in
   * the same reset window as the real step) never runs at all — its call
   * site is guarded on `step.from !== trait.initialState && step.from !==
   * '*'`, so a trait whose lifecycle creates a row FROM its own initial
   * state and then mutates it FROM that same state (PF's
   * `CREATE_TASK -> backlog` / `START_TASK: backlog -> in_progress`
   * shape) gets no reconcile preamble at all — reachability is trivially
   * satisfied (`from === initialState`), but the row was never created.
   *
   * `planDataMutationTests` populates this for `step.from === trait.
   * initialState`, AND (C1-V14, F4 — generalizing C1-V8) for a `step.from`
   * the pipeline's reconcile preamble DOES walk to but whose replay path
   * never actually TRAVERSES the row-establishing transition: a BFS
   * shortest path never revisits its own source state, so a self-loop AT
   * the initial state (PF's `CREATE_TASK: backlog -> backlog`) is never a
   * hop on the path to a state reached FROM that same initial state (PF's
   * `MOVE_STAGE: in_progress -> in_progress`, replayed via `START_TASK:
   * backlog -> in_progress`) — the "the existing reconcile mechanism
   * already establishes the row" assumption this doc used to state
   * unconditionally is FALSE for that shape. `planRowEstablishPreamble`
   * detects it by computing the same `planReplayTo` path the pipeline
   * will walk and checking whether an id-binding transition
   * (`collectEntityIdBindingTransitions`) or the row-creating hop itself
   * sits on it; when neither does, it falls through to the SAME two
   * disjuncts evaluated at the trait's INITIAL state and marks the result
   * `beforeReplay: true` (see that field's own doc). When `step.from`
   * differs AND the replay path DOES traverse the establishing
   * transition, the existing reconcile mechanism already establishes the
   * row (it walks the SAME topology and, for the `bindRowFrom`-equivalent
   * shape, already seeds a real row id via `entityIdBindingByTrait` /
   * `seedEntityIdIfBinding`) — setting this field there too would double-
   * dispatch the establishing transition.
   *
   * `tick()` never turns this hop into its own `Frame` when `beforeReplay`
   * is unset/false — it must not itself be scored as a `data-mutation`
   * test (mirrors how a `reconcile` frame carries no `testKind`); it is
   * purely a dispatch that happens to run before the step's real one,
   * inside the same `tick()` call. When `beforeReplay` IS `true`,
   * `runVerification` dispatches it itself as its OWN `reconcile` frame,
   * before the replay hops run (see that field's doc) — `tick()` must not
   * dispatch it again inside the step.
   */
  establishesRow?: {
    /** Event to dispatch as the preamble hop. */
    event: string;
    /**
     * Payload for the preamble dispatch, synthesized by
     * `planDataMutationTests` the same way it synthesizes every other
     * data-mutation step's payload (`buildMinimalPayload` over the
     * event's declared `payloadSchema`). Used as-is when `bindRowFrom`
     * is undefined (the create+id-bind shape — case 1); otherwise
     * `tick()` overwrites `payload[bindRowFrom.payloadField]` with a
     * real row's value before dispatching (case 2).
     */
    payload: Record<string, FieldValue>;
    /**
     * Fetch/select-bound trait shape (case 2): the preamble transition
     * binds `@entity.id` from a literal `@payload.<field>` reference
     * (`persist-binding.ts`'s `findEntityIdSetPayloadPath`), and the
     * planner cannot know a real row id ahead of time — only `tick()`
     * knows, from `entitiesBefore` at dispatch. When set, `tick()` looks
     * up the first row of `entityName` in `entitiesBefore` and merges
     * `{[payloadField]: row[payloadField]}` into `payload`; when no such
     * row exists at dispatch time, `tick()` fails the step closed with a
     * `no target row` finding instead of dispatching a guaranteed-denied
     * write.
     */
    bindRowFrom?: { entityName: string; payloadField: string };

    /**
     * C1-V9 item A: the viewer this preamble's OWN `persist create` needs
     * to run as, derived from the entity's `@create` policy
     * (`deriveViewerRequirement`). Set only when the creator establishes a
     * row for an entity that declares a `@create` policy — `tick()`
     * resolves it, switches persona before dispatching the preamble, and
     * stamps `payload[owner.payloadOwnerField]` with the same resolved id
     * so the new row self-declares ownership consistent with the switch.
     * Governs the MAIN step's own dispatch too (same tick() call, same
     * live row) — `step.viewerRequirement` is not consulted when this is
     * set.
     */
    viewerRequirement?: ViewerRequirement;

    /**
     * C1-V14 (F4): `true` when this step's `from` is NOT the trait's
     * initial state (or `'*'`) and the pipeline's own reconcile preamble
     * (`planReplayTo({ targetState: step.from })`) never traverses this
     * establishing transition on its way there — so `runVerification`
     * must dispatch this preamble ITSELF, as its own `reconcile`-kind
     * frame, right after `driver.reset(ctx)` and BEFORE walking the
     * replay hops (the row must exist before those hops — and the real
     * step after them — fire). Undefined/`false` (the original C1-V8
     * shape: `step.from === trait.initialState`) keeps the pre-existing
     * behavior — `tick()` dispatches it inline, immediately before the
     * step's own event, in the SAME call. `tick()` reads this to skip its
     * own in-step dispatch when the pipeline already sent it (never both).
     */
    beforeReplay?: boolean;

    /**
     * C1-V15 (item A, `guard-precondition.ts`): the trait to DISPATCH this
     * preamble against, when it differs from the guarded step's own
     * `traitName` — the sibling-establishes-a-guard-precondition shape
     * (std-helpdesk's `TicketReplyPersistor.DO_CREATE -> idle when
     * @entity.activeTicketId`, set only by a SIBLING trait's `SELECT_TICKET`).
     * Undefined means "the same trait as the step" (the original C1-V8/V14
     * `@entity.id` preambles, which are always same-trait). Always paired
     * with `beforeReplay: true` when set — a sibling's post-dispatch state
     * has no bearing on the CURRENT trait's own `tick()`-inline dispatch
     * timing, so this shape only ever goes through `runVerification`'s own
     * preamble dispatch, never `tick()`'s in-step one.
     */
    traitName?: string;

    /**
     * C1-V16 (`guard-precondition.ts`): the state `traitName` must be at
     * before `event` is dispatched — the selected setter's own anchor state
     * (a same-trait self-loop's `atState`, or a sibling's initial state).
     * Equal to the establishing trait's initial state in the common case;
     * when it differs (std-thread's `EDIT_REPLY`, only an arm at
     * `browsing`, not the trait's boot state `idle`), `runVerification`
     * replays the establishing trait to it FIRST (`planReplayTo`, its own
     * reconcile frames) before dispatching this preamble — dispatching
     * straight at the trait's boot state would silently no-op for an arm
     * that doesn't exist there.
     */
    establishAtState?: string;
  };

  /**
   * C1-V9 item B (R-PERSIST-NO-ROW-KEY-SILENT-SUCCESS, the persistor
   * shape): the step's OWN persist effect reads its target row (or the
   * row's id) directly from this top-level payload field — no preamble
   * hop needed, `tick()` fills `payload[payloadField]` from a seeded row
   * of `entityName` at dispatch time before firing the step itself.
   * `wholeRow: true` means the field takes the WHOLE row object
   * (`(persist update Note ?data)`); otherwise it takes the row's `id`
   * (`(persist delete Note ?id)`, `{ id: ?id, … }`). Mutually exclusive
   * with `establishesRow`/`unreachableRowReason` — see
   * `findPersistPayloadBinding`'s doc for the three shapes detected.
   */
  bindRowFrom?: {
    entityName: string;
    payloadField: string;
    wholeRow: boolean;
    /**
     * `delete` only: field names on `entityName` that relate back to
     * `entityName` itself (`selfRelationFieldNames`). `tick()` avoids
     * targeting a row any OTHER row references through one of these —
     * the mock seeder's self-referential tree shape makes the
     * structurally-default row (position 0) a root with children EVERY
     * time, which an `onDelete: restrict` rule then rejects regardless
     * of who the viewer is. Empty/undefined when the entity declares no
     * self-relation (nothing to avoid).
     */
    avoidReferencedVia?: readonly string[];
    /**
     * C1-V17: `(entityName, fieldName)` pairs on OTHER entities whose
     * restrict-rule relation field targets THIS `entityName`
     * (`crossEntityRestrictRelations`) — `enforceOnDeleteRules` blocks a
     * delete referenced from any entity, not just a self-relation.
     * `tick()` resolves each `entityName` to its live rows
     * (`serverRowsFor`) and folds them into the same referential-safety
     * check `avoidReferencedVia` drives. Empty/undefined when nothing
     * outside the entity itself ever restricts its delete.
     */
    avoidReferencedByOtherEntities?: ReadonlyArray<{ entityName: string; fieldName: string }>;
  };

  /**
   * C1-V9 item A: the viewer THIS step's own persist action needs to run
   * as, derived from the target entity's declared access policy for that
   * action (`deriveViewerRequirement`). Consulted only when
   * `establishesRow.viewerRequirement` is undefined — a creator preamble's
   * requirement governs the whole `tick()` call instead (see its doc).
   * `tick()` resolves this against `entitiesBefore` (owner case) or the
   * driver's default persona (create's `useDefaultId` case), switches
   * persona before dispatch, and restores the default after. An empty
   * `{}` (policy declared, nothing derivable) or a row-less owner lookup
   * fails the frame closed with a `no-satisfying-persona` finding —
   * never a silent dispatch under the wrong viewer.
   */
  viewerRequirement?: ViewerRequirement;

  /**
   * RV item 27 (`plan-transient-failure-probes.ts`): the NOMINAL failure
   * arm this step's forced dispatch is trying to prove, when it differs
   * from the step's own literal `(from, event, to)` — a transient
   * failure-route arm can only be observed by dispatching the transition
   * that ENTERS its `from` state under a denying viewer, so the actual
   * bus dispatch is that entering transition, not the failure arm
   * itself. `assertTransientFailureArmPortals` reads this (via
   * `frame.cause.verifiesPortalFor`) to know which portal expectation
   * the resulting cascade should be checked against, and scans
   * `frame.runtimeSnapshot.transitions` for the arm actually firing
   * (the same "server cascade credit" the coverage observer already
   * uses) rather than trusting the frame's own dispatched tuple.
   */
  verifiesPortalFor?: { traitName: string; from: string; event: string; to: string };

  /**
   * C1-V9 item C: for `crud-edit`/`crud-delete` steps (`planUserCrudFlow`),
   * whether the DOM affordance that opens this step is a genuine ROW
   * action — declared in an `itemActions`/`browseItemActions`-shaped
   * config array on the rendering trait, so it is stamped with
   * `data-row-id` once per row. `false` means the affordance is a plain
   * single button somewhere on the page (e.g. a detail page's own action
   * button reached via a cross-trait listener) — `Driver.triggerDOM` must
   * not require `[data-row-id]` on it, and a miss must not be reported as
   * `crud-affordance-absent` (a real product defect), only fall back like
   * any ordinary step. `undefined` is treated as `true` (the default,
   * pre-existing row-scoped behavior) for backward compatibility.
   */
  isRowAction?: boolean;

  /**
   * C1-V8: set instead of `establishesRow` when NEITHER a row-creating
   * self-loop nor a row-selecting `@payload`-bound transition exists
   * anywhere reachable from this step's `from` state — the trait never
   * legitimately binds `@entity.id` before this persist fires, so the
   * write cannot succeed by construction. `tick()` skips the dispatch
   * entirely (never a silent bus dispatch, never a pass) and records this
   * string as the frame's error — same family as `crudAffordanceAbsent`.
   */
  unreachableRowReason?: string;

  /**
   * C1-V11: for `crud-edit`/`crud-delete` steps (`planUserCrudFlow`) whose
   * `targetRowId` is left undefined (the planner never knows which row
   * exists at dispatch time), the self-relation field names
   * (`selfRelationFieldNames`) `tick()` must avoid targeting a row that
   * some OTHER row references through — `delete` only; always undefined
   * for `crud-edit` (a restrict-rule self-relation blocks a DELETE, never
   * an edit, so edit only needs SOME owned row, not an unreferenced one).
   *
   * `tick()` resolves the actual target row ONCE, before dispatch, via
   * `pickTargetRow(…, avoidReferencedVia, {requireUnreferenced: true when
   * this (or `avoidReferencedByOtherEntities`) is set and non-empty})` and
   * threads the SAME row into three places: `targetRowId`
   * (drives the DOM's row-scoped click), the viewer-switch `rowOverride`
   * (so the persona switched to is THAT row's owner), and `step.payload`
   * (so a bus-fallback dispatch carries a real id/row instead of `{}`).
   * No candidate found fails the frame closed — `no-target-row` when none
   * are seeded, `no-deletable-row` when every seeded row IS referenced
   * (`PickTargetRowFailureCode`) — same family as `unreachableRowReason` —
   * instead of clicking the mock seeder's
   * self-referential tree's row 0, which is a root with children EVERY
   * time and would be rejected by the runtime's own `onDelete: restrict`
   * rule regardless of viewer.
   */
  avoidReferencedVia?: readonly string[];

  /**
   * C1-V17: the cross-entity counterpart of {@link avoidReferencedVia}
   * (`crossEntityRestrictRelations`) — `(entityName, fieldName)` pairs on
   * OTHER entities whose restrict-rule relation targets this step's own
   * entity. `tick()` resolves each to its live rows the same way it does
   * for `bindRowFrom`'s copy of this field, and folds them into the SAME
   * `pickTargetRow` call `avoidReferencedVia` drives — a row referenced
   * only cross-entity (`ChannelMember.channel`, `ChatMessage.channel` both
   * pointing at `Channel`) is exactly as undeletable as a self-referenced
   * one, and the planner previously had no way to tell `tick()` about it.
   */
  avoidReferencedByOtherEntities?: ReadonlyArray<{ entityName: string; fieldName: string }>;

  /**
   * C1-V15 item B (`affordance-disabled.ts`): for `crud-edit`/`crud-delete`
   * steps whose `targetRowId` is left undefined, the `disabled` expression
   * governing the DOM affordance this step clicks — std-helpdesk's `RATE`
   * button is enabled only for a resolved, unrated ticket
   * (`disabled={(if (and (= ?data.status resolved) (not ?data.csatScore))
   * false true)}`); clicking it while disabled is a structural no-op (DOM
   * ✓, cascade ✗). `tick()`'s row resolution evaluates this per candidate
   * row (`@almadar/evaluator`, the same evaluator the runtime uses) and
   * excludes any row for which it evaluates `true` — no candidate left
   * closes the frame with `no-target-row` naming the reason, instead of
   * clicking a row the affordance would silently ignore. Undefined means
   * the affordance declares no evaluable `disabled` (never disabled, or a
   * bare boolean literal — the always-`true` case is
   * `crud-affordance-absent`'s job, not this filter's).
   */
  affordanceDisabledExpr?: AffordanceDisabledExpr;

  /**
   * C1-V15 item C: for `crud-delete` steps on an entity whose seed can
   * legitimately run out of unreferenced rows (`selfRelationFieldNames`
   * non-empty — std-time-tracking's `Employee.seedRow` self-relation,
   * `onDelete: restrict`), the SAME entity's own declared `crud-create`
   * flow, reduced to its bare persist dispatch — bus-fired directly against
   * the PERSISTOR trait (`event`/`traitName`), bypassing its own DOM/
   * form-fill proof (that proof already runs as this walk's SEPARATE
   * `crud-create` step; re-driving it here would just re-prove the same
   * thing while blocking the delete step on it).
   *
   * `tick()`'s crud row-resolution reaches for this ONLY when
   * `pickTargetRow` finds no candidate for the delete's OWN pick (the
   * "every seeded row is referenced" case is a RUNTIME fact, not knowable
   * at plan time) — dispatches this fallback once, then retries the pick
   * against the post-create server truth. The freshly-created row is
   * unreferenced by construction (nothing has had a chance to reference it
   * yet), so the retry finds it without any special-casing beyond "ask the
   * store again." Absent means the entity has no self-relation to run out
   * of headroom on, or the orbital declares no `create` for this entity —
   * `tick()` keeps today's `no-target-row` behavior unchanged.
   */
  deleteEstablishFallback?: {
    event: string;
    payload: Record<string, FieldValue>;
    traitName: string;
    viewerRequirement?: ViewerRequirement;
  };
}

/**
 * Input to `planWalk`. The trait's transitions + initialState are the
 * only required state-machine inputs; flags toggle the synthetic INIT
 * credit (default on) and the emit-sweep extension (default off — emit
 * sweep is a separate `planEmitSweep` call so callers can run it
 * independently).
 */
export interface PlanWalkInput {
  trait: TraitWalkConfig;
  /** Whether to prepend the synthetic auto-init step. Default: `true`. */
  includeAutoInit?: boolean;
  /**
   * v3.14.0: orbital-wide entity field defs keyed by entity name.
   * `planWalk` uses this to expand entity-typed payload fields when
   * synthesizing the `success` variant. Optional — when omitted,
   * synthesis still works but entity-typed fields fall back to faker
   * primitives instead of real entity-shaped rows.
   */
  entityFieldsByName?: Record<string, EntityFieldDef[]>;
  /**
   * The resolved schema the trait lives in. When given, every guarded
   * `pass` variant whose guard reads a non-id `@entity.<field>` gets the
   * establishing preamble `planGuardPreconditionPreamble` finds (or its
   * `guard-precondition-unreachable` reason) — the same precondition the
   * persist/CRUD planners already attach. Without it an emit-only guarded
   * arm is dispatched straight off the hermetic reset, where the boot has
   * just wiped the very field its guard reads.
   */
  orbital?: OrbitalSchema;
}

/** Input to `planEmitSweep`. */
export interface PlanEmitInput {
  trait: TraitWalkConfig;
  /** Emit declarations collected from the trait's effects. */
  emits: ReadonlyArray<EmitDeclaration>;
  /**
   * Full schema + the trait's owning `Orbital`, used to look up whether
   * firing a swept event navigates — either directly (the trait's own
   * transition from its initial state carries a `navigate`/`navigate-back`
   * effect) or via a listener's triggered arm (`dispatchNavigates`, the
   * one shared oracle `planWalk`/`planClickPathSamples`/`planReplayTo`
   * already consult). Optional: omitted only by call sites (and existing
   * unit tests) that don't have the schema in scope, in which case swept
   * steps carry no `navigates` flag — the same as before this field
   * existed.
   */
  schema?: OrbitalSchema;
  orb?: Orbital;
}

/** Input to `planReplayTo`. */
export interface PlanReplayInput {
  trait: TraitWalkConfig;
  targetState: string;
}

/** Input to `planTickTests`. */
export interface PlanTickInput {
  trait: TraitWalkConfig;
}
