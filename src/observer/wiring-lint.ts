/**
 * `lintWiring` — static, deterministic lint of an orbital's client wiring.
 *
 * Each check is a walk-discovered defect class promoted up the determinism
 * hierarchy: the full-fidelity browser walk found the class once; this lint
 * finds every future instance from the resolved schema alone, in
 * milliseconds. All checks are grounded in explicit IR contracts (page
 * decls, `@trait.X` embed edges, `emits`/`listens` payload schemas,
 * `action:`/`itemActions` affordance declarations) — no name matching, no
 * heuristics.
 *
 * Checks:
 *  - `unscoped-owned-entity` (warning) — a persisted entity that declares an
 *    owner column (a relation to the `[identity]` entity) but no `@read`
 *    directive. An undeclared policy is ALLOW-ALL, not deny-all, so every
 *    viewer reads every row while the app looks authorization-aware. This is
 *    the ratchet for the persona/authorization campaign: it measures how much
 *    of the corpus is still unscoped without reddening `orb validate`.
 *  - `app-theme-divergent` (warning) — a page-owning orbital that pins no
 *    `theme` config (or a different one) while sibling orbitals in the same
 *    app pin one. Its pages render in the ambient `@currentTheme` default
 *    instead of the app's declared theme — a whole page off-brand that
 *    validates 0/0 because each orbital is individually legal (the
 *    identity-roster class, 2026-08-19: 31 rosters shipped theme-less next to
 *    theme-pinned siblings). Theme values and pages are declared data — no
 *    name matching.
 *  - `identity-roster-unwritable` (warning) — the app declares an
 *    `[identity]` entity but no transition anywhere reaches a
 *    `persist create` on it: the roster the app's personas map onto has no
 *    write path, so users can never be added from inside the app (the
 *    read-only identity-directory class, 2026-08-19: 46 carriers).
 *  - `client-unbound-state-machine` — a trait owning a state machine that is
 *    in no page decl and not in any page's `@trait.X` embed closure. The
 *    client binds state machines exactly for page-declared traits plus that
 *    closure (`OrbPreview.allPageTraits`), so the trait can never handle an
 *    event in the shipped app (std-ecommerce `CartItemRemoveConfirm`: dead
 *    cart-remove modal).
 *  - `steady-state-no-init-reentry` (warning) — a state a trait settles in
 *    after one of its own `fetch` effects succeeds, which declares no `INIT`
 *    transition of its own. The server machine rests there between visits, so
 *    a revisit's re-INIT finds no transition and is dropped while the
 *    freshly-mounted client sits in `loading` forever (the 39-carrier
 *    W-ATOM-NO-INIT-REENTRY-IN-STEADY-STATE family: std-board `viewing_board`,
 *    std-invoice/std-donor/... `browsing`). Warning, not error, for the same
 *    reason as `unclaimed-main-writer`: whether a dropped re-INIT strands the
 *    user depends on who owns the page's content region afterwards, which
 *    statics cannot settle without a slot-outlet contract. Corpus calibration
 *    (2026-07-25): the `browsing`/`viewing` content-owner shapes are
 *    probe-proven carriers, while std-app-search's `results` is a proven FALSE
 *    positive — the page's content trait repaints main on revisit, live-probed
 *    GREEN through an in-app round trip. Live revisit probes remain the
 *    arbiter per finding.
 *  - `async-result-deaf-target` (warning) — a transition that CHANGES state
 *    while one of its `fetch`/`persist` effects declares `emit: { success,
 *    failure }` events the TARGET state does not handle: the requester departs
 *    to a state deaf to its own operation result, so when the cascade lands
 *    the machine drops it and deadlocks (the std-dunning `SET_STATUS ->
 *    loading` class, 2026-07-27: the persist's `DunningCaseUpdated` was only
 *    handled in `browsing`, wedging every subsequent walk step in `loading`).
 *    Self-transitions (`from === to`) are excluded — the machine stays in an
 *    interactive state, a different (render-drop) class, not a wedge.
 *  - `listens-source-never-emits` — a `listens { A.EVENT -> X }` route whose
 *    source trait exists but never produces EVENT (not in its emits
 *    contract, no effect `emit:` option, no `action:`/`itemActions`
 *    affordance) — the std-cicd wrong-source-listener class.
 *  - `payload-starved-route` — a route delivering EVENT to a listener whose
 *    own contract for the triggered event requires payload fields the
 *    source's declared emit sites cannot supply (std-lms header
 *    "Edit Selected" emitting `EDIT_COURSE` with no `id` while the modal
 *    contract demands `id: string!`).
 *  - `unclaimed-main-writer` (warning) — a page-declared trait rendering a
 *    content-grade body into slot `main` while the page's content channel
 *    (`contentTrait`/`idleContent` config slots) already claims one: the
 *    std-accounting `/entries` two-ledger-UIs class. Warning, not error:
 *    corpus calibration showed statics cannot split that class from the
 *    dedicated-feature convention (a page-mounted feature complementing the
 *    shell's catalog — healthcare `/patients/upload` and `/appointments/reminder`,
 *    both audited-good; std-booking-system `/appointments/board` survives as a
 *    likely-genuine stacked UI, pending arbitration). Placeholder-box
 *    main-writes (modal cleanup), atomic chrome, and claimed embeds are
 *    excluded. Owner + rival are both resolved through `@almadar/core`'s
 *    `resolvePageContentOwner`/`reduceToOwners` — a page-scoped, not
 *    orbital-wide, channel, with the same designation+containment reduction
 *    `viewer-stranded` uses (2026-08-02 recalibration: the pre-fix orbital-wide
 *    scan and missing containment test falsified all 10 std-winning-11
 *    findings — `ConnectionDetail` borrowing a sibling page's channel and
 *    `AssessmentForm` flagged as rival to its own materialised descendant).
 *    Supersedes the v1-falsified ">1 boot writers" candidate (see `Almadar_Verification_Gaps.md`
 *    V-WIRING-LINT-STRAY-WRITER-NEEDS-SLOT-OUTLET-CONTRACT).
 *  - `dead-lifecycle-action` — a rendered affordance targeting a lifecycle
 *    event (`INIT`, `LOAD`, `$MOUNT`). The affordance set is registry-derived,
 *    not a key list: `action:` plus every prop the node's own pattern declares
 *    as an event outlet (`kind: "event" | "event-ref" | "callback"` —
 *    `cancelEvent`, `retryEvent`, `onRetry`, …) and every `kind: "event-list"`
 *    descriptor array, via `eventKeyPropsOf`/`eventListPropsOf`. Reading only
 *    `action:` undercounted the class silently for every pattern that names its
 *    outlet something else (`V-DEAD-LIFECYCLE-ACTION-MISSES-EVENT-PROPS`).
 *    The runtime never delivers lifecycle events from the
 *    bus (`useTraitStateMachine` LIFECYCLE_EVENTS — correctly: a bare
 *    `UI:INIT` would broadcast a re-INIT into every trait on the page), so
 *    the control does nothing when clicked. The std-realtime-chat
 *    "Back to chat" class (2026-07-29): 63 sites across 31 organisms used
 *    `action={INIT}` as a Back affordance on screens that replaced `main`,
 *    stranding the viewer with no way home.
 *  - `dead-bodiless-action` — a state-CHANGING transition (`from !== to`) that
 *    carries no effects at all. `get_state_render_effects` (orbital-core
 *    `kernel.rs:530`) re-applies a state's render only in the no-transition
 *    branch, so arriving in a state BY transition paints exactly what the arm
 *    renders — nothing. The machine leaves the old state while the screen keeps
 *    its paint, so every affordance routed to that arm is dead AND the surface
 *    now disagrees with the state it is in. `dead-lifecycle-action` cannot see
 *    this class: the target is a first-class user event, and the affordance
 *    usually lives in a nested inline trait whose own machine has no such arm
 *    (std-builder `SchemaPreview`'s "Back to Editor", found by hand 2026-08-01
 *    while closing the D2 leftovers).
 *  - `dead-lifecycle-emit` — an arm whose effects `(emit INIT|LOAD|$MOUNT)`.
 *    The client publishes `UI:INIT` (`createClientEffectHandlers.ts:66`) but
 *    subscribes to no lifecycle event (`useTraitStateMachine.ts:1854,1911`), so
 *    the emit is dropped and whatever it meant to repaint never renders. The
 *    Rust kernel has no such exclusion, so this is also a two-path divergence.
 *  - `embedded-sibling-single-referrer` — a trait embedded via `@trait.X` by
 *    more than one referrer in one orbital. Both resolvers materialise a
 *    sub-view PER EMBEDDER, so this can only mean the invariant broke: the
 *    child's `@config.X` forwards chain to ONE referrer
 *    (`@almadar/core`'s `collectEmbeddedTraitReferrers` — first wins), and
 *    `useUISlots.updateTraitContent` is keyed by trait name, so the second
 *    embedder renders the first's data with the first's config. The
 *    C-SIBLING-PULL-SHARED-ACROSS-REBINDS class: `std-realtime-chat`'s
 *    conversation rail listed chat messages because `ChannelRail` and
 *    `ChatThread` shared one pulled `DenseTableView`.
 *  - `navigate-target-undeclared` (warning) — a `(navigate <target>)` effect
 *    whose target matches no declared `page "<path>"` in the app (positional
 *    `:param` matching both ways; a `str/concat`-built target is matched by
 *    its literal prefix against declared paths with their trailing `:param`
 *    segment stripped). `audit_listens` reports this arm `wired: true via
 *    self-transition` because the emit/listen wiring IS complete — the
 *    affordance is a live click that lands on a 404, a class no listens-graph
 *    check can see. Cross-orbital: an app's navigate targets routinely point
 *    at pages owned by a sibling orbital, so the declared-path universe is
 *    every page in the schema, not just the navigating trait's own orbital.
 *  - `page-absent-from-nav` (warning) — a declared page whose path carries no
 *    `:param` segment (a parameterized detail page is legitimately reached
 *    only via a row click, never a nav link — structural exclusion, not a
 *    name guess) and whose path appears as an `href` in NO `navItems`-shaped
 *    descriptor array anywhere in the app (the ATS `/staff` class: declared,
 *    live, and reachable by direct URL only — no AppLayout link reaches it).
 *    `href` extraction reuses the same structural descriptor-array parse
 *    `configItemActionEvents`/`descriptorEvents` already apply to
 *    `itemActions` — an object array entry carrying the field counts,
 *    regardless of which trait or config key it lives under. Only fully
 *    absent (zero navItems arrays) is reported in this version; a page
 *    present in some but not all of an app's navItems arrays is a distinct,
 *    softer class deliberately left unflagged. The app's root page ("/") is
 *    exempt — it is reached by default, not by a nav link. The check only
 *    runs once the app demonstrably uses the navItems convention at all (at
 *    least one page reachable through one) — an app with zero navItems
 *    arrays anywhere (a registry atom, a chrome-less fixture) has not opted
 *    into nav-driven reachability, so every page reading "absent" would be
 *    noise.
 *  - `detail-panel-back-in-actions` (warning, TEMPORARY migration aid — a
 *    burndown check retired once the corpus is clean) — a `detail-panel`
 *    pattern whose `actions` array carries an entry with `event: "BACK"`.
 *    `detail-panel` gained a first-class `backAction` prop (2026-08-20,
 *    `Almadar_UX.md` §8.4: back affordances render top-left) specifically so
 *    Back does not compete with the panel's own close control; a `BACK`
 *    left inside `actions` still renders top-right, next to the close X — the
 *    doctrine violation this check burns down.
 *  - `relation-field-rendered-raw` (warning) — a table-like pattern's
 *    `columns` entry (`{key|field}`) resolves, through the trait's
 *    `linkedEntity`, to a relation-typed entity field, carries no per-column
 *    `type`/`format` override, and the pattern node carries no
 *    `relationsData`. Since 2026-08-20 the runtime auto-injects
 *    `relationsData` server-side and the compiled path binds it at codegen —
 *    but ONLY for the three pattern types the registry tags
 *    `@fieldsContract` (`form`, `form-section`, `detail-panel`;
 *    `getPatternFieldsContract`, `@almadar/core`). Table/grid patterns
 *    (`entity-table`, `data-grid`, `table-view`, …) carry no `relationsData`
 *    prop in the registry at all and get no auto-injection on either path, so
 *    this check is scoped to exactly those un-healed surfaces — firing it on
 *    `detail-panel`/`form`/`form-section` would flag the now-healed common
 *    case, not a real gap.
 *
 * @packageDocumentation
 */

import type {
  AnyPatternConfig,
  Effect,
  EventPayload,
  Orbital,
  OrbitalEntity,
  OrbitalPage,
  OrbitalSchema,
  RenderBinding,
  ResolvedPatternProps,
  SExpr,
  Trait,
  TraitConfigValue,
} from '@almadar/core';
import { identityEntityName, ownerFieldsFromSchema } from '@almadar/core/mock';
import { collectBindings, collectTraitConfigRefAdjacency, collectTraitEmbedAdjacency, eventKeyPropsOf, eventListPropsOf, getPatternFieldsContract, isContentBodyPattern, isContentBodyPatternType, isContentMainWriter, isInlineTrait, isValueInputPattern, reduceToOwners, resolvePageContentOwner, isMainSlotRenderUi, isPageReference, traitDeclaresConfigForward } from '@almadar/core';
import { collectAsyncResultEvents, collectEffectEmittedEvents, collectFetchSuccessEvents } from '../planner/internal/effect-emits.js';

/** Every IR value shape the lint's tree walkers traverse: S-expressions
 *  (state machines), call-site config values, render-ui pattern payloads,
 *  and emit payloads. All are recursive JSON-shaped core types; object
 *  nodes iterate via the same record reinterpretation core's own
 *  `collectTraitRefsFromValue` uses. */
type ScanNode =
  | SExpr
  | TraitConfigValue
  | AnyPatternConfig
  | ResolvedPatternProps
  | RenderBinding
  | EventPayload
  | undefined;

export type WiringLintSeverity = 'error' | 'warning';

export interface WiringLintFinding {
  check:
    | 'client-unbound-state-machine'
    | 'steady-state-no-init-reentry'
    | 'async-result-deaf-target'
    | 'groupby-enum-column-gap'
    | 'listens-source-never-emits'
    | 'payload-starved-route'
    | 'unclaimed-main-writer'
    | 'dead-lifecycle-action'
    | 'dead-bodiless-action'
    | 'dead-lifecycle-emit'
    | 'mutation-affordance-never-persists'
    | 'viewer-stranded'
    | 'embedded-sibling-single-referrer'
    | 'unscoped-owned-entity'
    | 'app-theme-divergent'
    | 'identity-roster-unwritable'
    | 'navigate-target-undeclared'
    | 'page-absent-from-nav'
    | 'detail-panel-back-in-actions'
    | 'relation-field-rendered-raw';
  severity: WiringLintSeverity;
  orbital: string;
  trait: string;
  message: string;
  /** Ready-to-apply fix direction, phrased against the `.lolo` source. */
  suggestion: string;
  /**
   * Set when the finding is about an ENTITY rather than a trait
   * (`unscoped-owned-entity`). `trait` then carries the entity name too, so
   * existing consumers that print `trait` still show something meaningful.
   */
  entity?: string;
}

export interface WiringLintResult {
  findings: WiringLintFinding[];
  errors: number;
  warnings: number;
}

/** Payload field names the source trait can supply for `event`, from every
 *  declared production site: its emits contract's payloadSchema, explicit
 *  `['emit', event, {…}]` effects, and `itemActions` entries (which deliver
 *  the native `{id, row}` payload per the DataGrid/browse contract). */
function suppliedPayloadFields(trait: Trait, event: string): Set<string> | 'runtime-forwarded' {
  const supplied = new Set<string>();
  let declaredAnywhere = false;

  for (const emit of trait.emits ?? []) {
    if (emit.event !== event) continue;
    declaredAnywhere = true;
    for (const field of emit.payloadSchema ?? []) supplied.add(field.name);
  }

  for (const transition of trait.stateMachine?.transitions ?? []) {
    for (const effect of transition.effects ?? []) {
      if (!Array.isArray(effect) || effect[0] !== 'emit' || effect[1] !== event) continue;
      declaredAnywhere = true;
      const payload = effect[2];
      if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
        for (const key of Object.keys(payload)) supplied.add(key);
      }
    }
  }

  if (configItemActionEvents(trait).has(event)) {
    declaredAnywhere = true;
    supplied.add('id');
    supplied.add('row');
  }

  // A production site we cannot enumerate payload keys for (a rendered
  // `action:` affordance forwards its `actionPayload` at runtime) — only
  // treat the payload as unknowable when no enumerable site declared the
  // event either.
  if (!declaredAnywhere && collectRenderActionEvents(trait).has(event)) return 'runtime-forwarded';
  return supplied;
}

/** Object-node view of a `ScanNode` — the same record reinterpretation core's
 *  `collectTraitRefsFromValue` applies to `SExprAtom` object nodes. */
function asRecordNode(node: object): Readonly<Record<string, ScanNode>> {
  return node as Readonly<Record<string, ScanNode>>;
}

/** Events reachable as an affordance prop anywhere in the trait's render-ui
 *  trees or config values (inline buttons scope their emit to the composer).
 *
 *  Two sources, both declared:
 *  - `action:` on any node — the shape every clickable core primitive uses,
 *    read unscoped because it also appears in bare config descriptors that
 *    carry no `type:` to resolve against;
 *  - every OTHER prop the node's own pattern declares as an event outlet
 *    (`eventKeyPropsOf` — `cancelEvent`, `retryEvent`, `onRetry`, …), resolved
 *    against `type:` so the prop's meaning comes from the registry rather than
 *    from its name. */
function collectRenderActionEvents(trait: Trait): Set<string> {
  const out = new Set<string>();
  const scan = (node: ScanNode): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node) scan(child);
      return;
    }
    if (typeof node !== 'object') return;
    const record = asRecordNode(node);
    const action = record['action'];
    if (typeof action === 'string' && action.length > 0) out.add(action);
    const patternType = record['type'];
    if (typeof patternType === 'string') {
      for (const prop of eventKeyPropsOf(patternType)) {
        const value = record[prop];
        if (typeof value === 'string' && value.length > 0) out.add(value);
      }
    }
    for (const value of Object.values(record)) scan(value);
  };
  for (const transition of trait.stateMachine?.transitions ?? []) {
    for (const effect of transition.effects ?? []) {
      if (Array.isArray(effect) && effect[0] === 'render-ui' && effect[2] != null) scan(effect[2]);
    }
  }
  if (trait.config) scan(trait.config);
  return out;
}

/**
 * Rendered affordances as `(event, label)` pairs — buttons and action
 * descriptors that carry BOTH a target event and user-visible text.
 *
 * The label is what makes `mutation-affordance-never-persists` safe to run:
 * plenty of arms legitimately only re-fetch or navigate, so the check keys on
 * controls whose own wording promises something durable ("Archive", "Publish").
 * Without that, the rule flags every read-only affordance in the corpus.
 */
function labelledAffordances(trait: Trait): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  const scan = (node: ScanNode): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node) scan(child);
      return;
    }
    if (typeof node !== 'object') return;
    const record = asRecordNode(node);
    const label = record['label'];
    if (typeof label === 'string' && label.length > 0) {
      const action = record['action'];
      if (typeof action === 'string' && action.length > 0) out.push([action, label] as const);
      const event = record['event'];
      if (typeof event === 'string' && event.length > 0) out.push([event, label] as const);
      const patternType = record['type'];
      if (typeof patternType === 'string') {
        for (const prop of eventKeyPropsOf(patternType)) {
          const value = record[prop];
          if (typeof value === 'string' && value.length > 0) out.push([value, label] as const);
        }
      }
    }
    for (const value of Object.values(record)) scan(value);
  };
  for (const transition of trait.stateMachine?.transitions ?? []) {
    for (const effect of transition.effects ?? []) {
      if (Array.isArray(effect) && effect[0] === 'render-ui' && effect[2] != null) scan(effect[2]);
    }
  }
  if (trait.config) scan(trait.config);
  return out;
}

/**
 * Every event an arm's own render puts on screen as a control, label or not.
 *
 * This is the confirmation edge. `REQUEST_VOID` renders a confirm dialog whose
 * button fires `CONFIRM_VOID`, and only `CONFIRM_VOID` persists — so a walk
 * that follows emits and listens alone declares the Void button dead when the
 * flow is exactly right. Rendering a control that fires X *is* a way to reach
 * X; the user is the edge.
 */
function renderedAffordanceEvents(effects: ReadonlyArray<Effect> | undefined): Set<string> {
  const out = new Set<string>();
  const scan = (node: ScanNode): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node) scan(child);
      return;
    }
    if (typeof node !== 'object') return;
    const record = asRecordNode(node);
    for (const key of ['action', 'event']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) out.add(value);
    }
    const patternType = record['type'];
    if (typeof patternType === 'string') {
      for (const prop of eventKeyPropsOf(patternType)) {
        const value = record[prop];
        if (typeof value === 'string' && value.length > 0) out.add(value);
      }
    }
    for (const value of Object.values(record)) scan(value);
  };
  for (const effect of effects ?? []) {
    if (Array.isArray(effect) && effect[0] === 'render-ui' && effect[2] != null) scan(effect[2]);
  }
  return out;
}

/** `@trait.X` names an arm's render embeds — the control usually lives in X. */
function embeddedTraitRefs(effects: ReadonlyArray<Effect> | undefined): Set<string> {
  const out = new Set<string>();
  const scan = (node: ScanNode): void => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      if (node.startsWith('@trait.')) out.add(node.slice('@trait.'.length));
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) scan(child);
      return;
    }
    if (typeof node !== 'object') return;
    for (const value of Object.values(asRecordNode(node))) scan(value);
  };
  for (const effect of effects ?? []) {
    if (Array.isArray(effect) && effect[0] === 'render-ui' && effect[2] != null) scan(effect[2]);
  }
  return out;
}

/**
 * Every event an embedded trait can fire — what it declares in `emits`, plus
 * any affordance in its own config.
 *
 * `events { ACTION: CONFIRM_VOID_CLICKED }` on the call site is a RENAME, and
 * resolve has already applied it: the button's `emits` carries the renamed
 * event by the time the lint sees it. So `emits` is the honest source here, not
 * the rename map.
 */
function configAffordanceEvents(trait: Trait): Set<string> {
  const out = new Set<string>();
  const scan = (node: ScanNode): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node) scan(child);
      return;
    }
    if (typeof node !== 'object') return;
    const record = asRecordNode(node);
    for (const key of ['action', 'event']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) out.add(value);
    }
    const patternType = record['type'];
    if (typeof patternType === 'string') {
      for (const prop of eventKeyPropsOf(patternType)) {
        const value = record[prop];
        if (typeof value === 'string' && value.length > 0) out.add(value);
      }
    }
    for (const value of Object.values(record)) scan(value);
  };
  if (trait.config) scan(trait.config);
  for (const emit of trait.emits ?? []) {
    if (typeof emit.event === 'string' && emit.event.length > 0) out.add(emit.event);
  }
  return out;
}

/**
 * Does this `main` body still offer the viewer a way on?
 *
 * JSX hoists every inline component into its own `@trait.InlineXRenderN`, so
 * the payload is mostly `"@trait.…"` strings and a naive scan sees no props.
 * Three things count, and the first two are why the pre-contract drafts of
 * this rule flagged 832 and 672 arms respectively:
 *   1. a DATA SURFACE — a pattern the registry gives a `kind: "entity"` prop.
 *      Its rows ARE the navigation.
 *   2. a LABELLED control — an event paired with visible text. Labelless does
 *      not count: `EmptyState.ACTION` with no `actionLabel` declares an event
 *      and renders no button, which is the dead affordance being hunted.
 *   3. a NON-INLINE sibling embed, which brings its own surface.
 */
function mainWriteOffersAWayOn(body: ScanNode, traits: ReadonlyMap<string, Trait>): boolean {
  const visited = new Set<string>();
  const LABEL_KEYS = ['label', 'actionLabel', 'submitLabel', 'cancelLabel'] as const;
  let found = false;

  const scan = (node: ScanNode): void => {
    if (found || node === null || node === undefined) return;
    if (typeof node === 'string') {
      if (!node.startsWith('@trait.')) return;
      const name = node.slice('@trait.'.length);
      const embedded = traits.get(name);
      if (embedded === undefined) return;
      if (!isInlineTrait(embedded)) { found = true; return; }
      if (visited.has(name)) return;
      visited.add(name);
      for (const transition of embedded.stateMachine?.transitions ?? []) {
        for (const effect of transition.effects ?? []) {
          if (Array.isArray(effect) && effect[0] === 'render-ui' && effect[2] != null) scan(effect[2]);
        }
      }
      if (embedded.config) scan(embedded.config);
      return;
    }
    if (Array.isArray(node)) { for (const child of node) scan(child); return; }
    if (typeof node !== 'object') return;
    const record = asRecordNode(node);
    const patternType = record['type'];
    if (typeof patternType === 'string' && isContentBodyPatternType(patternType)) { found = true; return; }
    // A label must be VISIBLE TEXT. `actionLabel: "@config.actionLabel"` is an
    // unresolved forward with no default — `orbital resolve` leaves the sigil
    // in place and the control never renders, which is the dead affordance
    // being hunted, not an exit. Counting it made the check silent on a file
    // that provably carried the defect. An ARRAY node is different: it is an
    // S-expression (`str/concat`, `object/get` over a config roster) the
    // render evaluator resolves to text, so it counts as visible.
    const labelled = LABEL_KEYS.some((key) => {
      const value = record[key];
      if (typeof value === 'string') return value.length > 0 && !value.startsWith('@') && !value.startsWith('?');
      return Array.isArray(value) && value.length > 0;
    });
    if (labelled) {
      for (const key of ['action', 'event']) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0 && !LIFECYCLE_EVENTS.has(value)) found = true;
      }
      if (!found && typeof patternType === 'string') {
        for (const prop of eventKeyPropsOf(patternType)) {
          const value = record[prop];
          if (typeof value === 'string' && value.length > 0 && !LIFECYCLE_EVENTS.has(value)) { found = true; break; }
        }
      }
    }
    // A value-input pattern (registry: `value` prop + an event outlet) renders
    // its affordance from `value` alone — a labelless slider is still draggable,
    // unlike a labelless button. Wired event = a way on.
    if (!found && typeof patternType === 'string' && isValueInputPattern(patternType)) {
      for (const prop of eventKeyPropsOf(patternType)) {
        const value = record[prop];
        if (typeof value === 'string' && value.length > 0 && !LIFECYCLE_EVENTS.has(value)) { found = true; break; }
      }
    }
    if (found) return;
    for (const value of Object.values(record)) scan(value);
  };

  scan(body);
  return found;
}

/** Mount-time events the runtime fires internally, once per trait, and
 *  deliberately never delivers from the bus (`useTraitStateMachine`
 *  LIFECYCLE_EVENTS — the qualified self-subscription and the bare-cascade
 *  routing both skip them). A rendered affordance targeting one is dead. */
const LIFECYCLE_EVENTS: ReadonlySet<string> = new Set(['INIT', 'LOAD', '$MOUNT']);

/** An action-descriptor array is recognised STRUCTURALLY, not by name: a
 *  config array whose entries are objects carrying an `event` string is what
 *  the substrate turns into bus-emitting affordances. That is the source tag.
 *  The old hardcoded `['itemActions','agendaItemActions','detailActions']`
 *  list is gone — it silently missed every knob nobody thought to add
 *  (`S-EVENT-LIST-PROPS-UNDECLARED-IN-REGISTRY`). Where a node declares a
 *  `type:`, `eventListPropsOf` stays authoritative, because the registry is
 *  the only thing that knows a descriptor's event field is named something
 *  other than `event`.
 */
function descriptorEvents(value: unknown, eventField: string): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const event = asRecordNode(entry)[eventField];
    if (typeof event === 'string' && event.length > 0) out.push(event);
  }
  return out;
}

/** Events declared in `itemActions`-shaped config arrays anywhere in the
 *  trait's config tree (`[{ event, label, … }]`). */
function configItemActionEvents(trait: Trait): Set<string> {
  const out = new Set<string>();
  const scan = (node: ScanNode): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node) scan(child);
      return;
    }
    if (typeof node !== 'object') return;
    const record = asRecordNode(node);
    const patternType = record['type'];
    const declared =
      typeof patternType === 'string' ? eventListPropsOf(patternType) : new Map<string, string>();
    for (const [key, raw] of Object.entries(record)) {
      // Resolved orbs carry config values knob-wrapped ({ default, type });
      // the descriptor array lives under `default`.
      const actions =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? asRecordNode(raw)['default']
          : raw;
      for (const event of descriptorEvents(actions, declared.get(key) ?? 'event')) out.add(event);
    }
    for (const value of Object.values(record)) scan(value);
  };
  if (trait.config) scan(trait.config);
  for (const transition of trait.stateMachine?.transitions ?? []) {
    for (const effect of transition.effects ?? []) {
      if (Array.isArray(effect) && effect[0] === 'render-ui' && effect[2] != null) scan(effect[2]);
    }
  }
  return out;
}

/** Every event the trait can produce, by any declared mechanism. */
function producibleEvents(trait: Trait): Set<string> {
  const out = new Set<string>();
  for (const emit of trait.emits ?? []) out.add(emit.event);
  for (const event of collectEffectEmittedEvents(trait.stateMachine?.transitions ?? [])) out.add(event);
  for (const transition of trait.stateMachine?.transitions ?? []) {
    for (const effect of transition.effects ?? []) {
      if (Array.isArray(effect) && effect[0] === 'emit' && typeof effect[1] === 'string') out.add(effect[1]);
    }
  }
  for (const event of collectRenderActionEvents(trait)) out.add(event);
  for (const event of configItemActionEvents(trait)) out.add(event);
  return out;
}

/** Required payload field names the listener itself declares for `event`
 *  (its own emits-contract entry — the atom idiom declares the contract on
 *  the consuming trait so call sites know what to supply). */
function requiredContractFields(listener: Trait, event: string): Set<string> {
  const required = new Set<string>();
  for (const emit of listener.emits ?? []) {
    if (emit.event !== event) continue;
    for (const field of emit.payloadSchema ?? []) {
      if (field.required === true) required.add(field.name);
    }
  }
  return required;
}

/** Page-declared trait names plus the transitive `@trait.X` embed closure —
 *  the exact set the client binds state machines for. */
/** Inline page definitions only — imported page refs carry no trait list. */
function inlinePages(orb: Orbital): OrbitalPage[] {
  const out: OrbitalPage[] = [];
  for (const ref of orb.pages ?? []) {
    if (!isPageReference(ref)) out.push(ref);
  }
  return out;
}

function clientBoundTraits(orb: Orbital, adjacency: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const bound = new Set<string>();
  const queue: string[] = [];
  for (const page of inlinePages(orb)) {
    for (const pageTrait of page.traits ?? []) {
      if (!bound.has(pageTrait.ref)) {
        bound.add(pageTrait.ref);
        queue.push(pageTrait.ref);
      }
    }
  }
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    for (const child of adjacency.get(current) ?? []) {
      if (!bound.has(child)) {
        bound.add(child);
        queue.push(child);
      }
    }
  }
  return bound;
}

/** True when this one effect list paints a content-grade body into `main`,
 *  including through `if` branches. Shared by the trait-level writer test and
 *  the per-transition steady-state test. */
function writesContentMain(effects: ReadonlyArray<Effect> | undefined): boolean {
  const scanNode = (node: unknown): boolean => {
    if (!Array.isArray(node)) return false;
    if (isMainSlotRenderUi(node)) return isContentBodyPattern(node[2]);
    return node.some(scanNode);
  };
  return (effects ?? []).some((effect) => scanNode(effect));
}

export function lintWiring(schema: OrbitalSchema): WiringLintResult {
  const findings: WiringLintFinding[] = [];

  for (const orb of schema.orbitals) {
    const traits = new Map<string, Trait>();
    // Call-site REF-traits (`{name, ref}` — composed schemas keep them
    // unresolved) EXIST as listen-route sources even though their bodies are
    // not inline. Existence and producibility are separate questions: names
    // of ALL declared traits feed the existence arm; producibility stays
    // decidable only for inline bodies (a ref-trait's emits live behind the
    // unresolved ref).
    const declaredTraitNames = new Set<string>();
    for (const traitRef of orb.traits ?? []) {
      if (isInlineTrait(traitRef)) traits.set(traitRef.name, traitRef);
      if (typeof traitRef === 'object' && traitRef !== null && 'name' in traitRef && typeof traitRef.name === 'string') {
        declaredTraitNames.add(traitRef.name);
      }
    }
    const pages = inlinePages(orb);
    if (pages.length === 0) continue;

    const adjacency = collectTraitEmbedAdjacency(orb);
    // The content channel — config-slot `@trait.X` edges. Feeds both the
    // page-content-owner contract (viewer-stranded) and unclaimed-main-writer.
    const channelAdj = collectTraitConfigRefAdjacency(orb);
    const bound = clientBoundTraits(orb, adjacency);
    const producible = new Map<string, Set<string>>();
    for (const [name, trait] of traits) producible.set(name, producibleEvents(trait));

    // --- client-unbound-state-machine -----------------------------------
    for (const [name, trait] of traits) {
      const transitions = trait.stateMachine?.transitions ?? [];
      if (transitions.length === 0) continue;
      if (bound.has(name)) continue;
      const childPages = pages
        .filter((page) =>
          (page.traits ?? []).some((pageTrait) => (adjacency.get(name) ?? new Set()).has(pageTrait.ref)),
        )
        .map((page) => page.path);
      findings.push({
        check: 'client-unbound-state-machine',
        severity: 'error',
        orbital: orb.name,
        trait: name,
        message:
          `${name} owns a state machine (${transitions.length} transition(s)) but is in no page decl and no page's ` +
          `@trait embed closure — the client never binds it, so it can never handle an event in the shipped app`,
        suggestion:
          childPages.length > 0
            ? `add ${name} to the page decl mounting its embedded children (${childPages.join(', ')})`
            : `add ${name} to the page decl of the page whose traits route events to it`,
      });
    }

    // --- dead-lifecycle-action -------------------------------------------
    for (const [name, trait] of traits) {
      const actionEvents = collectRenderActionEvents(trait);
      const descriptorEvents = configItemActionEvents(trait);
      for (const event of new Set([...actionEvents, ...descriptorEvents])) {
        if (!LIFECYCLE_EVENTS.has(event)) continue;
        findings.push({
          check: 'dead-lifecycle-action',
          severity: 'error',
          orbital: orb.name,
          trait: name,
          message:
            `${name} renders an affordance targeting '${event}' — a lifecycle event the runtime never delivers ` +
            `from the bus, so the control does nothing when clicked`,
          suggestion:
            `emit a first-class user event instead; if this is a "back" affordance on a screen that replaced main, ` +
            `recut the screen as a modal overlay owned by a dedicated overlay trait (the std-realtime-chat ` +
            `ChatOverlayPanel shape), so dismissing is one (render-ui modal null) and main is never repainted`,
        });
      }
    }

    // --- dead-bodiless-action --------------------------------------------
    // `get_state_render_effects` re-applies a state's render ONLY in the
    // no-transition branch, so entering a state BY transition paints exactly
    // what that arm renders. An arm with no effects at all therefore paints
    // nothing — the affordance pointing at it is as dead as one targeting INIT,
    // and the lifecycle check above never sees it.
    for (const [name, trait] of traits) {
      if (!bound.has(name)) continue; // an unbound trait's arms never run at all
      // States this trait actually paints. A lifecycle trait that renders
      // nothing has no paint to strand, so its effect-less arms are not a
      // defect — the finding only exists where a screen is left standing.
      const painted = new Set(
        (trait.stateMachine?.transitions ?? [])
          .filter((transition) => (transition.effects ?? []).some((effect) => isMainSlotRenderUi(effect)))
          .map((transition) => transition.to),
      );
      for (const arm of trait.stateMachine?.transitions ?? []) {
        if (arm.from === arm.to) continue; // a self-transition leaves the current paint standing
        if ((arm.effects ?? []).length > 0) continue;
        if (!painted.has(arm.from)) continue;
        findings.push({
          check: 'dead-bodiless-action',
          severity: 'error',
          orbital: orb.name,
          trait: name,
          message:
            `${name}: '${arm.event}' moves ${arm.from} -> ${arm.to} but carries no effects — the machine leaves ` +
            `${arm.from} while the screen keeps ${arm.from}'s paint, so every affordance routed here is dead and ` +
            `the surface now disagrees with the state it is in`,
          suggestion:
            `give the arm the body ${arm.to} should show — copy ${arm.to}'s INIT render (and its fetch, if any) ` +
            `into the arm. An (emit INIT) is not a substitute: the bus never delivers lifecycle events`,
        });
      }
    }

    // --- mutation-affordance-never-persists ------------------------------
    // A control wired to a real, deliverable event whose arm chain reaches no
    // `persist`. Neither sibling check can see it: `dead-lifecycle-action`
    // needs a lifecycle target, `dead-bodiless-action` needs an EMPTY effects
    // list — these arms have effects, just not durable ones. Verified live 7+
    // times (std-moderation-rule ARCHIVE_RULE, std-help-{article,category}
    // PUBLISH/ARCHIVE, std-donation-receipt, std-donor, std-time-tracking ×3),
    // each a button whose spinner claims to save and does not.
    //
    // Deliberately narrow, to stay quiet on the legitimate shapes: only
    // affordances whose LABEL names a mutation are considered, and an arm that
    // reaches a persist *transitively* (via an event it emits, within this
    // trait) counts as persisting.
    // The chain is ORBITAL-WIDE, not per-trait: the corpus idiom is a modal
    // emitting SAVE, a sibling persistor `listens { Modal.SAVE -> DO_CREATE }`,
    // and the persist living on DO_CREATE. A per-trait walk flags every one of
    // those as dead. So close over emits AND listens across all traits to a
    // fixpoint, then ask whether the affordance's event reaches a persist.
    const hasPersist = (effects: ReadonlyArray<Effect> | undefined): boolean =>
      (effects ?? []).some((e) => Array.isArray(e) && typeof e[0] === 'string' && e[0].startsWith('persist'));
    const persisting = new Set<string>();
    for (const [, trait] of traits) {
      for (const arm of trait.stateMachine?.transitions ?? []) {
        if (hasPersist(arm.effects)) persisting.add(arm.event);
      }
    }
    for (let pass = 0; pass < 8; pass++) {
      const before = persisting.size;
      for (const [, trait] of traits) {
        // a listens route `Source.EVENT -> LOCAL`: firing EVENT triggers LOCAL
        for (const listen of trait.listens ?? []) {
          const local = listen.triggers;
          if (typeof local === 'string' && persisting.has(local) && typeof listen.event === 'string') {
            persisting.add(listen.event);
          }
        }
        for (const arm of trait.stateMachine?.transitions ?? []) {
          if (persisting.has(arm.event)) continue;
          for (const effect of arm.effects ?? []) {
            if (!Array.isArray(effect) || effect[0] !== 'emit') continue;
            const emitted = effect[1];
            if (typeof emitted === 'string' && persisting.has(emitted)) {
              persisting.add(arm.event);
              break;
            }
          }
          if (persisting.has(arm.event)) continue;
          // …and the confirmation edge: this arm RENDERS a control that fires
          // an event that persists — directly, or through an embedded
          // `@trait.X` whose own config carries the action. Without it, every
          // two-step request -> confirm -> write flow reads as a dead control.
          const reachable = renderedAffordanceEvents(arm.effects);
          for (const ref of embeddedTraitRefs(arm.effects)) {
            const embedded = traits.get(ref);
            if (embedded) for (const e of configAffordanceEvents(embedded)) reachable.add(e);
          }
          for (const rendered of reachable) {
            if (persisting.has(rendered)) {
              persisting.add(arm.event);
              break;
            }
          }
        }
      }
      if (persisting.size === before) break;
    }
    // Only labels that PROMISE durability. "Cancel"/"Close"/"Back" abort a flow
    // and are correct with no persist; including them made the first draft of
    // this check flag 10 controls in one file, all of them fine.
    // approve/reject/submit/promote added 2026-08-16 (dead-persist-action
    // promotion): std-timesheet shipped all four as no-op refetches and every
    // gate stayed green — the verbs promise a durable status write exactly as
    // hard as "publish" does.
    const MUTATING_LABEL = /^(archive|publish|unpublish|deactivate|retire|void|revoke|issue|approve|reject|submit|promote)\b/i;
    for (const [name, trait] of traits) {
      if (!bound.has(name)) continue;
      const arms = trait.stateMachine?.transitions ?? [];
      const seen = new Set<string>();
      for (const [event, label] of labelledAffordances(trait)) {
        if (LIFECYCLE_EVENTS.has(event)) continue;           // dead-lifecycle-action owns these
        if (!MUTATING_LABEL.test(label)) continue;
        if (!arms.some((a) => a.event === event)) continue;  // unhandled: a different class
        if (persisting.has(event)) continue;
        if (seen.has(event)) continue;                        // one finding per control
        seen.add(event);
        findings.push({
          check: 'mutation-affordance-never-persists',
          severity: 'warning',
          orbital: orb.name,
          trait: name,
          message:
            `${name}: '${label}' fires '${event}', and no arm reachable from it anywhere in this orbital ` +
            `persists — the control is delivered and handled, but nothing durable happens, so the change ` +
            `is lost on reload`,
          suggestion:
            `give the arm a (persist create|update|delete …), or route it into the arm that already ` +
            `persists. A re-fetch is not a save: it re-reads the row the click was supposed to change`,
        });
      }
    }

    // --- viewer-stranded ---------------------------------------------------
    // The CONTENT OWNER of a page repaints its own region, on a user-triggered
    // arm, with a body offering no way on. That owner gate is the whole rule:
    // without it (three calibrations, 832 -> 672 -> 135 findings) a std-filter
    // arm re-rendering its own filter surface reads as a dead end, and the
    // FINISHED exemplar std-helpdesk came back dirty. `resolvePageContentOwner`
    // (`@almadar/core`) supplies the missing fact.
    //
    // "User-triggered" is derived, never guessed from the event's name: the
    // event must be rendered as an affordance somewhere in this orbital, or be
    // routed from one by a `listens` line. That excludes lifecycle mounts and
    // every `*Loaded`/`*Failed` async result by construction.
    // An event a trait PRODUCES, minus the ones a fetch/persist produces as its
    // own result. Seeding from rendered affordances alone was silently inert:
    // `notificationClickEvent: EMPLOYEE_NOTIFICATIONS_OPEN` is a config value on
    // a node whose `type:` is itself a config forward, so `eventKeyPropsOf` can
    // resolve nothing and the event was never collected — the check found zero
    // on a file that provably carried the defect. Proven by a positive control:
    // the pre-fix `std-hr-portal` must report its strand.
    const asyncResults = new Set<string>();
    for (const [, trait] of traits) {
      for (const event of collectEffectEmittedEvents(trait.stateMachine?.transitions ?? [])) {
        asyncResults.add(event);
      }
    }
    // Everything anything in this orbital can fire, async results included — a
    // fetch's success event is a perfectly good way out of a loading screen.
    const allProducible = new Set<string>(asyncResults);
    for (const [, trait] of traits) {
      for (const event of producibleEvents(trait)) allProducible.add(event);
      for (const listen of trait.listens ?? []) {
        if (typeof listen.triggers === 'string') allProducible.add(listen.triggers);
      }
    }
    const affordanceEvents = new Set<string>();
    const admit = (event: unknown): void => {
      if (typeof event !== 'string' || event.length === 0) return;
      if (asyncResults.has(event) || LIFECYCLE_EVENTS.has(event)) return;
      affordanceEvents.add(event);
    };
    for (const [, trait] of traits) {
      for (const event of producibleEvents(trait)) admit(event);
      // A `listens { Source.EVENT -> LOCAL }` route DECLARES that Source
      // produces EVENT — the one place a chrome event survives resolution. A
      // renamed layout event (`notificationClickEvent: X_NOTIFICATIONS_OPEN`)
      // lands in config as `{default: "…", type: "unknown"}`, so `eventKeyPropsOf`
      // can resolve nothing and the atom's own `emits` comes back empty.
      for (const listen of trait.listens ?? []) admit(listen.event);
    }
    for (let pass = 0; pass < 8; pass++) {
      const before = affordanceEvents.size;
      for (const [, trait] of traits) {
        for (const listen of trait.listens ?? []) {
          if (typeof listen.event !== 'string' || !affordanceEvents.has(listen.event)) continue;
          if (typeof listen.triggers === 'string') affordanceEvents.add(listen.triggers);
        }
      }
      if (affordanceEvents.size === before) break;
    }
    const owners = new Set<string>();
    for (const page of pages) {
      const owner = resolvePageContentOwner(page, traits, channelAdj, adjacency);
      // `ambiguous` is deliberately NOT an owner: two content bodies on one page
      // is the `unclaimed-main-writer` class, reported there, and picking one
      // here is exactly the guess this contract exists to stop.
      if (owner.kind === 'channel' || owner.kind === 'sole-writer') owners.add(owner.trait);
    }
    for (const name of owners) {
      const trait = traits.get(name);
      if (trait === undefined) continue;
      const seen = new Set<string>();
      for (const arm of trait.stateMachine?.transitions ?? []) {
        const event = arm.event;
        if (typeof event !== 'string' || LIFECYCLE_EVENTS.has(event)) continue;
        if (!affordanceEvents.has(event) || seen.has(event)) continue;
        // TRANSIENT screens are not strands. Two ways an exit-less body is
        // legitimately temporary:
        //   - the arm itself runs a fetch/persist, whose result arm repaints;
        //   - the arm LEAVES for another state that handles some other event
        //     something in this orbital actually produces (std-builder's
        //     "Starting preview runtime…" waits on a sibling's
        //     `(emit PREVIEW_STARTED)`, not on a fetch).
        // A SELF-transition gets no such credit: you were already in that
        // state, so its other arms were reachable before the click too.
        if ((arm.effects ?? []).some((e) => Array.isArray(e) && (e[0] === 'fetch' || e[0] === 'persist'))) continue;
        if (arm.from !== arm.to) {
          const escapes = (trait.stateMachine?.transitions ?? []).some(
            (other) =>
              other.from === arm.to &&
              typeof other.event === 'string' &&
              other.event !== event &&
              !LIFECYCLE_EVENTS.has(other.event) &&
              allProducible.has(other.event),
          );
          if (escapes) continue;
        }
        for (const effect of arm.effects ?? []) {
          if (!isMainSlotRenderUi(effect)) continue;
          const body = effect[2];
          if (body === null || body === undefined) continue;   // a deliberate clear
          if (mainWriteOffersAWayOn(body as ScanNode, traits)) continue;
          seen.add(event);
          findings.push({
            check: 'viewer-stranded',
            severity: 'error',
            orbital: orb.name,
            trait: name,
            message:
              `${name} owns this page's content region, and '${event}' repaints it with a body that ` +
              `carries no data surface, no labelled control and no sibling embed — the screen the viewer ` +
              `came from is gone and there is nothing to click`,
            suggestion:
              `render this OVER the page instead of replacing it: move the body into a dedicated overlay ` +
              `trait writing only 'modal' (a modal-close arm rendered from the trait that owns 'main' is ` +
              `rejected by CIRCUIT_MODAL_EXIT_INCOMPLETE, which is why it needs its own trait), or give ` +
              `the arm a labelled control back to the state it came from`,
          });
          break;
        }
      }
    }


    // --- dead-lifecycle-emit ---------------------------------------------
    // `(emit INIT)` as a repaint: the client publishes `UI:INIT`
    // (`createClientEffectHandlers.ts:66`) but nothing subscribes to it — both
    // the self and bare-cascade subscription loops skip LIFECYCLE_EVENTS
    // (`useTraitStateMachine.ts:1854,1911`). The arm therefore runs its sets
    // and paints nothing. The Rust kernel has no such exclusion, so this also
    // diverges between the two execution paths.
    for (const [name, trait] of traits) {
      for (const arm of trait.stateMachine?.transitions ?? []) {
        for (const effect of arm.effects ?? []) {
          if (!Array.isArray(effect) || effect[0] !== 'emit') continue;
          const event = effect[1];
          if (typeof event !== 'string' || !LIFECYCLE_EVENTS.has(event)) continue;
          findings.push({
            check: 'dead-lifecycle-emit',
            severity: 'error',
            orbital: orb.name,
            trait: name,
            message:
              `${name}: '${arm.event}' (${arm.from} -> ${arm.to}) emits '${event}' — the client subscribes to no ` +
              `lifecycle event, so the emit is dropped and whatever it was meant to repaint never renders ` +
              `(the Rust kernel has no such exclusion, so the two paths also disagree)`,
            suggestion:
              `render inline instead: put the body '${event}' would have painted directly in this arm. If the ` +
              `intent was to re-run a fetch, carry the (fetch …) here too`,
          });
        }
      }
    }

    // --- steady-state-no-init-reentry ------------------------------------
    for (const [name, trait] of traits) {
      const machine = trait.stateMachine;
      const transitions = machine?.transitions ?? [];
      if (transitions.length === 0) continue;

      // Only page-mounted traits can strand a user: an unbound trait's dropped
      // INIT paints nothing either way.
      if (!bound.has(name)) continue;

      const loadedBy = collectFetchSuccessEvents(transitions);
      if (loadedBy.size === 0) continue;

      // `from: '*'` is a legal state name in the IR's transition contract and
      // means "any state", so one wildcard INIT covers every steady state.
      if (transitions.some((t) => t.event === 'INIT' && t.from === '*')) continue;

      const initialState = machine?.states?.find((state) => state.isInitial)?.name;
      const statesWithInit = new Set(
        transitions.filter((t) => t.event === 'INIT').map((t) => t.from),
      );

      // The stranded surface has to be a content body in `main`: a state that
      // paints only chrome (or nothing) has no spinner to hang on.
      const contentStates = new Set(
        transitions
          .filter((t) => writesContentMain(t.effects))
          // Effects paint on the way IN, so the body belongs to the target state.
          .map((t) => t.to),
      );

      const loadedStates = new Set(
        transitions.filter((t) => loadedBy.has(t.event)).map((t) => t.to),
      );

      for (const state of loadedStates) {
        if (!contentStates.has(state)) continue;
        // The initial state's own INIT is what performed the load.
        if (state === initialState) continue;
        if (statesWithInit.has(state)) continue;
        findings.push({
          check: 'steady-state-no-init-reentry',
          severity: 'warning',
          orbital: orb.name,
          trait: name,
          message:
            `${name} settles in '${state}' after a fetch succeeds, but '${state}' handles no INIT — on a page revisit ` +
            `the server machine is already resting there and drops the client's re-INIT, so the surface hangs on its spinner`,
          suggestion:
            `add an INIT re-entry to '${state}' in ${name} that re-fetches and RE-ENTERS '${state}' ` +
            `without repainting a loading body — the shape std-browse uses. Copying the loading ` +
            `state's INIT verbatim reintroduces the flicker: '${state}' already holds rendered ` +
            `content, so a skeleton render unmounts it on every revisit`,
        });
      }
    }

    // --- embedded-sibling-single-referrer ---------------------------------
    // Invert the embed adjacency: every child must have exactly one referrer.
    // The pull materialises per embedder on both paths, so a second referrer
    // means the two are sharing one declaration — and a declaration can only
    // carry one entity rebind, one call-site config chain and one render.
    const referrersByChild = new Map<string, string[]>();
    for (const [referrer, children] of adjacency) {
      for (const child of children) {
        if (!traits.has(child)) continue;
        const list = referrersByChild.get(child);
        if (list) list.push(referrer);
        else referrersByChild.set(child, [referrer]);
      }
    }
    for (const [child, referrers] of referrersByChild) {
      if (referrers.length < 2) continue;
      // Discriminator, not a heuristic: only a child that declares a
      // `@config.X` forward has an embedder-dependent render. Corpus
      // calibration (2026-07-29): 45 traits are embedded twice, 44 of them
      // inert shared chrome (one `Divider`/`Typography` embedded from two
      // states of the same trait pair) that renders identically either way.
      // The remaining one is the real class.
      if (!traitDeclaresConfigForward(traits.get(child))) continue;
      const sorted = [...referrers].sort();
      findings.push({
        check: 'embedded-sibling-single-referrer',
        severity: 'warning',
        orbital: orb.name,
        trait: child,
        message:
          `${child} declares @config forwards and is embedded via @trait by ${referrers.length} referrers ` +
          `(${sorted.join(', ')}) — one declaration cannot serve two embedders: its forwards chain to the first ` +
          `referrer only, and the client keys rendered content by trait name, so the second embedder shows the ` +
          `first's resolved config`,
        suggestion:
          `declare ${child} once per embedder (the sibling pull does exactly this for imported atoms), or move ` +
          `the forwarded knobs to literals so the render no longer depends on which trait embeds it`,
      });
    }

    // --- async-result-deaf-target -----------------------------------------
    for (const [name, trait] of traits) {
      const transitions = trait.stateMachine?.transitions ?? [];
      if (transitions.length === 0) continue;
      const handledIn = (state: string): Set<string> =>
        new Set(transitions.filter((t) => t.from === state || t.from === '*').map((t) => t.event));
      for (const transition of transitions) {
        if (transition.from === transition.to) continue;
        const results = collectAsyncResultEvents(transition.effects ?? []);
        if (results.size === 0) continue;
        const handled = handledIn(transition.to);
        const deaf = [...results].filter((event) => !handled.has(event));
        if (deaf.length === 0) continue;
        findings.push({
          check: 'async-result-deaf-target',
          severity: 'warning',
          orbital: orb.name,
          trait: name,
          message:
            `${name}: '${transition.from} + ${transition.event} -> ${transition.to}' fires a fetch/persist whose ` +
            `result event(s) ${deaf.map((e) => `'${e}'`).join(', ')} are not handled in '${transition.to}' — the ` +
            `cascade lands on a deaf state and the machine wedges there`,
          suggestion:
            `handle ${deaf.map((e) => `'${e}'`).join(', ')} in '${transition.to}' (mirror the arms the source state ` +
            `declares for them), or route the effect's emit to an event '${transition.to}' already handles`,
        });
      }
    }

    // --- groupby-enum-column-gap ------------------------------------------
    // Structural contract: a trait config carrying BOTH a `groupByField`
    // string and a `columns` array of `{ key }` descriptors buckets rows by
    // strict key equality — a linked-entity enum value with no matching
    // column key silently hides its rows (the std-board cancelled-class).
    // Detected by config SHAPE, never by atom name.
    for (const [name, trait] of traits) {
      const config = trait.config;
      if (config === null || typeof config !== 'object' || Array.isArray(config)) continue;
      const record = config as Readonly<Record<string, TraitConfigValue>>;
      const groupByField = record['groupByField'];
      const columns = record['columns'];
      if (typeof groupByField !== 'string' || groupByField.length === 0) continue;
      if (!Array.isArray(columns) || columns.length === 0) continue;
      const columnKeys = new Set<string>();
      for (const col of columns) {
        if (col !== null && typeof col === 'object' && !Array.isArray(col)) {
          const key = (col as Readonly<Record<string, TraitConfigValue>>)['key'];
          if (typeof key === 'string' && key.length > 0) columnKeys.add(key);
        }
      }
      if (columnKeys.size === 0) continue;
      const entityName = trait.linkedEntity;
      if (typeof entityName !== 'string') continue;
      // Inline entity decls live on `orb.entity` (primary) + `auxiliaryEntities`.
      const entityRefs = [orb.entity, ...(orb.auxiliaryEntities ?? [])];
      const entity = entityRefs.find(
        (ref): ref is Extract<typeof ref, { name: string }> =>
          typeof ref === 'object' && ref !== null && 'fields' in ref && ref.name === entityName,
      );
      const field = entity?.fields?.find((f) => f.name === groupByField);
      const values = field !== undefined && 'values' in field ? field.values : undefined;
      if (!Array.isArray(values) || values.length === 0) continue;
      const hidden = values.filter((v): v is string => typeof v === 'string' && !columnKeys.has(v));
      if (hidden.length === 0) continue;
      findings.push({
        check: 'groupby-enum-column-gap',
        severity: 'warning',
        orbital: orb.name,
        trait: name,
        message:
          `${name} buckets ${entityName} rows by '${groupByField}' into columns [${[...columnKeys].join(', ')}], ` +
          `but the field's enum also allows [${hidden.join(', ')}] — rows with those values match no column and silently disappear`,
        suggestion: `add a column entry for each missing key (${hidden.join(', ')}) or narrow the ${entityName}.${groupByField} enum`,
      });
    }

    // --- relation-field-rendered-raw ---------------------------------------
    // Table-like patterns (`columns`) never get the 2026-08-20 relationsData
    // auto-injection — that lands only on the three `@fieldsContract`-tagged
    // patterns (`getPatternFieldsContract`). A column keyed to a relation
    // field, with no per-column type/format override and no authored
    // relationsData, renders the raw related id.
    for (const [name, trait] of traits) {
      const entityName = trait.linkedEntity;
      if (typeof entityName !== 'string') continue;
      const entityRefs = [orb.entity, ...(orb.auxiliaryEntities ?? [])];
      const entity = entityRefs.find(
        (ref): ref is Extract<typeof ref, { name: string }> =>
          typeof ref === 'object' && ref !== null && 'fields' in ref && ref.name === entityName,
      );
      if (entity === undefined) continue;
      const relationFields = new Set(
        (entity.fields ?? []).filter((f) => f.type === 'relation').map((f) => f.name),
      );
      if (relationFields.size === 0) continue;
      const seenColumns = new Set<string>();
      const scan = (node: ScanNode): void => {
        if (node === null || node === undefined) return;
        if (Array.isArray(node)) {
          for (const child of node) scan(child);
          return;
        }
        if (typeof node !== 'object') return;
        const record = asRecordNode(node);
        const patternType = record['type'];
        const columns = record['columns'];
        if (
          typeof patternType === 'string' &&
          Array.isArray(columns) &&
          getPatternFieldsContract(patternType) === undefined &&
          record['relationsData'] === undefined
        ) {
          for (const col of columns) {
            if (col === null || typeof col !== 'object' || Array.isArray(col)) continue;
            const colRecord = asRecordNode(col as object);
            if (colRecord['type'] !== undefined || colRecord['format'] !== undefined) continue;
            const key = colRecord['key'] ?? colRecord['field'];
            if (typeof key !== 'string' || !relationFields.has(key)) continue;
            if (seenColumns.has(key)) continue;
            seenColumns.add(key);
            findings.push({
              check: 'relation-field-rendered-raw',
              severity: 'warning',
              orbital: orb.name,
              trait: name,
              message:
                `${name}'s ${patternType} shows column '${key}' on ${entityName}, a relation-typed field, with no ` +
                `type/format override and no relationsData — the column renders the raw related id instead of a label`,
              suggestion:
                `add relationsData for '${key}' on this ${patternType} (the server-side auto-injection only ` +
                `covers form/form-section/detail-panel), or give the column an explicit type/format that resolves ` +
                `the relation to a label`,
            });
          }
        }
        for (const value of Object.values(record)) scan(value);
      };
      for (const transition of trait.stateMachine?.transitions ?? []) {
        for (const effect of transition.effects ?? []) {
          if (Array.isArray(effect) && effect[0] === 'render-ui' && effect[2] != null) scan(effect[2]);
        }
      }
      if (trait.config) scan(trait.config);
    }

    // --- detail-panel-back-in-actions (TEMPORARY migration aid — retires
    // once the corpus is clean; see header doc) ----------------------------
    for (const [name, trait] of traits) {
      const scan = (node: ScanNode): void => {
        if (node === null || node === undefined) return;
        if (Array.isArray(node)) {
          for (const child of node) scan(child);
          return;
        }
        if (typeof node !== 'object') return;
        const record = asRecordNode(node);
        const actions = record['type'] === 'detail-panel' ? record['actions'] : undefined;
        if (Array.isArray(actions)) {
          const hasBack = actions.some(
            (entry) =>
              entry !== null &&
              typeof entry === 'object' &&
              !Array.isArray(entry) &&
              asRecordNode(entry as object)['event'] === 'BACK',
          );
          if (hasBack) {
            findings.push({
              check: 'detail-panel-back-in-actions',
              severity: 'warning',
              orbital: orb.name,
              trait: name,
              message:
                `${name} renders a detail-panel with a BACK entry inside 'actions' — detail-panel's first-class ` +
                `'backAction' prop renders top-left (Almadar_UX §8.4); a BACK left in 'actions' renders top-right, ` +
                `next to the close X`,
              suggestion: `move the BACK entry out of 'actions' into 'backAction: {label, event: "BACK"}'`,
            });
          }
        }
        for (const value of Object.values(record)) scan(value);
      };
      for (const transition of trait.stateMachine?.transitions ?? []) {
        for (const effect of transition.effects ?? []) {
          if (Array.isArray(effect) && effect[0] === 'render-ui' && effect[2] != null) scan(effect[2]);
        }
      }
      if (trait.config) scan(trait.config);
    }

    // --- listens-source-never-emits + payload-starved-route --------------
    for (const [listenerName, listener] of traits) {
      for (const listen of listener.listens ?? []) {
        const source = listen.source;
        if (source === undefined || !('kind' in source) || source.kind !== 'trait') continue;
        const sourceName = source.trait;
        if (typeof sourceName !== 'string') continue;
        const sourceTrait = traits.get(sourceName);
        if (sourceTrait === undefined) {
          // A declared REF-trait source exists; its producibility is behind
          // the unresolved ref and not statically decidable here — skip, do
          // not report a phantom missing-source (composed-schema false
          // positive class, G-REPAIR-RESET-1 round 3).
          if (declaredTraitNames.has(sourceName)) continue;
          findings.push({
            check: 'listens-source-never-emits',
            severity: 'error',
            orbital: orb.name,
            trait: listenerName,
            message: `listens route ${sourceName}.${listen.event} -> ${listen.triggers}: source trait ${sourceName} does not exist in orbital ${orb.name}`,
            suggestion: `point the listens route at the trait that actually emits ${listen.event}`,
          });
          continue;
        }
        const sourceEvents = producible.get(sourceName) ?? new Set<string>();
        if (!sourceEvents.has(listen.event)) {
          const candidates = [...traits.entries()]
            .filter(([, candidate]) => producibleEvents(candidate).has(listen.event))
            .map(([candidateName]) => candidateName);
          findings.push({
            check: 'listens-source-never-emits',
            severity: 'error',
            orbital: orb.name,
            trait: listenerName,
            message:
              `listens route ${sourceName}.${listen.event} -> ${listen.triggers}: ${sourceName} never produces ` +
              `${listen.event} (not in its emits contract, effects, or rendered affordances) — the route is dead`,
            suggestion:
              candidates.length > 0
                ? `rewire to the actual emitter: ${candidates.map((candidate) => `${candidate}.${listen.event}`).join(' or ')}`
                : `no trait in ${orb.name} produces ${listen.event} — add the affordance or drop the route`,
          });
          continue;
        }

        const required = requiredContractFields(listener, listen.triggers);
        if (required.size === 0) continue;
        const supplied = suppliedPayloadFields(sourceTrait, listen.event);
        if (supplied === 'runtime-forwarded') continue;
        // payloadMapping is {targetField: SExpr} — every value is evaluated
        // against the source payload (core `applyListenPayloadMapping`). A
        // value reads the source only through its `@payload.<field>` bindings:
        // none at all is a literal or a self-contained computation and supplies
        // the field unconditionally; otherwise every field it reads must itself
        // be supplied, or the expression evaluates over a hole.
        const mapped = new Set(supplied);
        for (const [toField, expr] of Object.entries(listen.payloadMapping ?? {})) {
          const reads = collectBindings(expr)
            .filter((b) => b.startsWith('@payload.'))
            .map((b) => b.slice('@payload.'.length));
          if (reads.every((field) => supplied.has(field))) mapped.add(toField);
        }
        const missing = [...required].filter((field) => !mapped.has(field));
        if (missing.length > 0) {
          findings.push({
            check: 'payload-starved-route',
            severity: 'error',
            orbital: orb.name,
            trait: listenerName,
            message:
              `route ${sourceName}.${listen.event} -> ${listen.triggers}: ${listenerName} requires ` +
              `{${missing.join(', ')}} but ${sourceName}'s declared emit sites for ${listen.event} supply ` +
              `{${[...supplied].join(', ') || 'nothing'}} — the affordance is payload-starved and can never satisfy the contract`,
            suggestion: `emit ${listen.event} from a row-scoped affordance (itemActions supplies {id, row} natively) or add the missing fields to the emit payload`,
          });
        }
      }
    }
    // --- unclaimed-main-writer ------------------------------------------
    // The defect is TWO content bodies painting one page's main: one claimed
    // through the content channel (contentTrait/idleContent config slots) and
    // one page-mounted but never embedded. Corpus calibration (2026-07-23):
    // statics cannot split the /entries duplicate-body class from the
    // dedicated-feature convention (a page-mounted feature complementing the
    // shell's catalog), so this check REPORTS (warning) for human/runtime
    // arbitration — `slot:contention` in the client console + page captures
    // are the arbiters. Modals (placeholder-box main-writes), atomic chrome,
    // and claimed embeds are excluded by construction.
    //
    // The owner itself is `resolvePageContentOwner` (`@almadar/core`) — the
    // SAME fact `viewer-stranded` uses above — not a local recompute. A local
    // channel scan over `collectTraitConfigRefAdjacency` ORBITAL-WIDE (the
    // pre-fix shape) borrows a sibling page's channel edge for a page whose
    // own declared trait paints nothing of the kind (std-winning-11
    // `ConnectionDetail` on `/connections/:id`: no channel of its own, wrongly
    // compared against `/connections`'s), and skips the CONTAINMENT reduction
    // `resolvePageContentOwner` already applies for a channel's own ancestry:
    // `orbital resolve` materialises nested JSX (`<Card>`, `<SimpleGrid>`,
    // std-browse's `DataGrid1`/`DenseTableView`/`MasterListView` chain) into
    // synthetic sibling traits that chain via `@trait.X` CONFIG forwards, and
    // the composing ancestor that embeds/contains that chain in its own
    // render-ui (std-winning-11 `AssessmentForm` over `InlineFormSectionRender31`)
    // is not a rival to its own descendant. `reduceToOwners` (also core, also
    // shared, not a second copy) is the single test for "related, not rival":
    // reducing `{owner, candidate}` to one member means one is the other's
    // ancestor or descendant through EITHER relation (designation OR
    // containment, either direction) — exactly the two relations the owner
    // contract itself is built from.
    const claimedByBound = new Set<string>();
    for (const [source, targets] of adjacency) {
      if (!bound.has(source)) continue;
      for (const target of targets) claimedByBound.add(target);
    }
    for (const page of pages) {
      const owner = resolvePageContentOwner(page, traits, channelAdj, adjacency);
      // `none`/`sole-writer` mean there is at most one content body on this
      // page BY CONSTRUCTION (`resolvePageContentOwner` already reduces every
      // page-declared writer through the same designation+containment test) —
      // nothing left that could be a second, unclaimed one.
      if (owner.kind === 'none' || owner.kind === 'sole-writer') continue;
      const ownerNames = owner.kind === 'channel' ? [owner.trait] : owner.candidates;
      const relatedToOwner = (name: string): boolean =>
        ownerNames.some((ownerName) => reduceToOwners(new Set([ownerName, name]), channelAdj, adjacency).length === 1);

      for (const pageTrait of page.traits ?? []) {
        const name = pageTrait.ref;
        if (ownerNames.includes(name)) continue;
        if (claimedByBound.has(name)) continue;
        const trait = traits.get(name);
        if (trait === undefined || !isContentMainWriter(trait)) continue;
        if (relatedToOwner(name)) continue;
        findings.push({
          check: 'unclaimed-main-writer',
          severity: 'warning',
          orbital: orb.name,
          trait: name,
          message:
            `page "${page.path}": ${name} renders a content body into slot 'main' while ${ownerNames.join(' / ')} ` +
            `already owns this page's content — a second, stacked UI if this is not a deliberate dedicated-feature page`,
          suggestion:
            `embed <trait.${name} /> in the composer's render or a config slot (contentTrait/idleContent), ` +
            `or remove ${name} from the page decl if it only hosts dialogs/logic`,
        });
      }
    }

  }

  // --- unscoped-owned-entity ---------------------------------------------
  // Owner columns come from `ownerFieldsFromSchema`, which resolves them from
  // the DECLARED relation to the `[identity]` entity — never by name matching,
  // so it cannot scope the wrong column. Empty when the app declares no
  // identity, which keeps every un-migrated app silent.
  const ownerColumns = ownerFieldsFromSchema(schema);
  if (ownerColumns.length > 0) {
    const ownersByEntity = new Map<string, string[]>();
    for (const pair of ownerColumns) {
      const [entityName, fieldName] = pair.split('.');
      if (entityName === undefined || fieldName === undefined) continue;
      ownersByEntity.set(entityName, [...(ownersByEntity.get(entityName) ?? []), fieldName]);
    }
    for (const orb of schema.orbitals) {
      for (const ref of [orb.entity, ...(orb.auxiliaryEntities ?? [])]) {
        if (typeof ref !== 'object' || ref === null || !('fields' in ref)) continue;
        const def = ref as OrbitalEntity;
        const owners = ownersByEntity.get(def.name);
        if (owners === undefined || owners.length === 0) continue;
        if (def.read_policy !== undefined) continue;
        // `@read none "<reason>"` — the author declared the omission and said
        // why. Treat it as answered: a lint that keeps flagging correct code is
        // one agents learn to scroll past.
        if (def.access_waivers?.read !== undefined) continue;
        findings.push({
          check: 'unscoped-owned-entity',
          severity: 'warning',
          orbital: orb.name,
          trait: def.name,
          entity: def.name,
          message:
            `${def.name} declares owner column(s) ${owners.map((f) => `\`${f}\``).join(', ')} ` +
            `pointing at the [identity] entity, but no @read directive — and an undeclared policy is ` +
            `ALLOW-ALL, not deny-all, so every viewer reads every row`,
          suggestion:
            `declare @read on ${def.name} scoping rows to the viewer, e.g. ` +
            `@read ["=", (object/get @entity ${owners[0]}), @user.id] — or, when visibility genuinely ` +
            `depends on a DIFFERENT entity (a membership/enrolment join a per-row predicate cannot ` +
            `express), omit @read and state that reason in a comment on the entity, citing ` +
            `R-ENTITY-ACCESS-NO-COLLECTION-AGGREGATE-BINDING`,
        });
      }
    }
  }

  // --- app-theme-divergent -------------------------------------------------
  // Theme values are DECLARED trait-config data and page ownership is the
  // declared page list, so coherence is decidable without name matching. Only
  // literal pins count — a `@currentTheme`-shaped value is "unpinned", which
  // keeps apps that uniformly ride the ambient default silent.
  const themePinOf = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value.startsWith('@') ? undefined : value;
    if (typeof value === 'object' && value !== null && 'default' in value) {
      const d = (value as { default?: unknown }).default;
      return typeof d === 'string' && !d.startsWith('@') ? d : undefined;
    }
    return undefined;
  };
  const pinnedByOrbital = new Map<string, Set<string>>();
  for (const orb of schema.orbitals) {
    const pinned = new Set<string>();
    for (const trait of orb.traits ?? []) {
      // The theme overlay lives on ref-traits (composed app-layout call
      // sites) as much as inline ones — read `config` off any object trait.
      if (typeof trait !== 'object' || trait === null || !('config' in trait)) continue;
      const config = trait.config as Record<string, unknown> | undefined;
      const pin = themePinOf(config?.theme);
      if (pin !== undefined) pinned.add(pin);
    }
    pinnedByOrbital.set(orb.name, pinned);
  }
  // An app-level `theme "<key>"` declaration (schema.theme) is authoritative:
  // an unpinned orbital INHERITS it through `@currentTheme`, so only pins
  // that CONTRADICT it are drift. Without one, fall back to the dominant-vote
  // heuristic over the pins themselves (the pre-app-theme corpus shape).
  const appThemeKey = ((): string | undefined => {
    const t = schema.theme as unknown;
    if (typeof t === 'string' && t.length > 0) return t;
    if (typeof t === 'object' && t !== null && 'name' in t) {
      const n = (t as { name?: unknown }).name;
      return typeof n === 'string' && n.length > 0 ? n : undefined;
    }
    return undefined;
  })();
  if (appThemeKey !== undefined) {
    for (const orb of schema.orbitals) {
      const pinned = pinnedByOrbital.get(orb.name) ?? new Set<string>();
      const divergent = [...pinned].filter((t) => t !== appThemeKey).sort();
      if (divergent.length === 0) continue;
      findings.push({
        check: 'app-theme-divergent',
        severity: 'warning',
        orbital: orb.name,
        trait: orb.name,
        message:
          `${orb.name} pins theme ${divergent.map((t) => `"${t}"`).join(', ')} while the app ` +
          `declares "${appThemeKey}" at the app level`,
        suggestion:
          `remove the config pin so the orbital inherits the app theme via @currentTheme — or, ` +
          `for a deliberate per-orbital override, declare it as the orbital's own \`theme "<key>"\``,
      });
    }
  } else {
    const themeVotes = new Map<string, number>();
    for (const pinned of pinnedByOrbital.values()) {
      for (const theme of pinned) themeVotes.set(theme, (themeVotes.get(theme) ?? 0) + 1);
    }
    if (themeVotes.size > 0 && schema.orbitals.length > 1) {
      const dominant = [...themeVotes.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
      for (const orb of schema.orbitals) {
        if (inlinePages(orb).length === 0) continue;
        const pinned = pinnedByOrbital.get(orb.name) ?? new Set<string>();
        if (pinned.has(dominant)) continue;
        const divergent = [...pinned].sort();
        findings.push({
          check: 'app-theme-divergent',
          severity: 'warning',
          orbital: orb.name,
          trait: orb.name,
          message:
            divergent.length === 0
              ? `${orb.name} owns pages but pins no \`theme\`, so they render in the ambient ` +
                `default theme while the rest of the app pins "${dominant}"`
              : `${orb.name} pins theme ${divergent.map((t) => `"${t}"`).join(', ')} while the ` +
                `rest of the app pins "${dominant}"`,
          suggestion:
            `declare the app theme once as a \`theme "${dominant}"\` app-header line (preferred), ` +
            `or add \`theme: "${dominant}"\` to the orbital's app-layout trait config`,
        });
      }
    }
  }

  // --- identity-roster-unwritable ------------------------------------------
  // The `[identity]` entity is the app's persona roster. A roster no
  // transition can `persist create` into has no write path: users can never
  // be added from inside the app, even though every read surface looks
  // complete. Effects are scanned recursively so persists nested in `if`
  // branches count.
  const identityName = identityEntityName(schema);
  if (identityName !== undefined) {
    const createsIdentity = (node: unknown): boolean => {
      if (!Array.isArray(node)) return false;
      if (node[0] === 'persist' && node[1] === 'create' && node[2] === identityName) return true;
      return node.some(createsIdentity);
    };
    let hasCreatePath = false;
    for (const orb of schema.orbitals) {
      for (const trait of orb.traits ?? []) {
        if (!isInlineTrait(trait)) continue;
        for (const arm of trait.stateMachine?.transitions ?? []) {
          if ((arm.effects ?? []).some(createsIdentity)) {
            hasCreatePath = true;
            break;
          }
        }
        if (hasCreatePath) break;
      }
      if (hasCreatePath) break;
    }
    if (!hasCreatePath) {
      const owner =
        schema.orbitals.find(
          (orb) =>
            typeof orb.entity === 'object' &&
            orb.entity !== null &&
            'name' in orb.entity &&
            orb.entity.name === identityName,
        ) ?? schema.orbitals[0];
      if (owner !== undefined) {
        findings.push({
          check: 'identity-roster-unwritable',
          severity: 'warning',
          orbital: owner.name,
          trait: identityName,
          entity: identityName,
          message:
            `${identityName} is the app's [identity] roster but no transition reaches a ` +
            `\`persist create ${identityName}\` — the roster is read-only, so users can never ` +
            `be added from inside the app`,
          suggestion:
            `compose the app's create mechanism into the ${identityName} orbital: an Add ` +
            `affordance emitting CREATE, a \`Modal.traits.ModalRecordModal\` create modal, and a ` +
            `persistor trait whose DO_CREATE arm runs \`(persist create ${identityName} ?data)\``,
        });
      }
    }
  }

  // --- navigate-target-undeclared -------------------------------------------
  // The declared-path universe is the WHOLE app: a navigate target routinely
  // points at a page owned by a sibling orbital (an AppLayout's cross-feature
  // links), so this is cross-orbital, unlike the per-orb checks above.
  const allPages = schema.orbitals.flatMap((orb) => inlinePages(orb));
  const pathSegments = (path: string): string[] => path.split('/').filter((segment) => segment.length > 0);
  // The prefix a `str/concat`-built target can be compared against: a page's
  // path with its trailing `:param` segment stripped (only a TRAILING param
  // segment — a mid-path param like "/contacts/:id/edit" has no such prefix).
  const paramStrippedPrefix = (path: string): string | undefined => {
    const segments = pathSegments(path);
    const last = segments[segments.length - 1];
    if (last === undefined || !last.startsWith(':')) return undefined;
    return `/${segments.slice(0, -1).join('/')}/`;
  };
  const isPathDeclared = (target: string): boolean => {
    const targetSegments = pathSegments(target);
    return allPages.some((page) => {
      const pageSegments = pathSegments(page.path);
      if (pageSegments.length !== targetSegments.length) return false;
      return pageSegments.every(
        (segment, i) =>
          segment === targetSegments[i] || segment.startsWith(':') || targetSegments[i]!.startsWith(':'),
      );
    });
  };
  const isPrefixDeclared = (prefix: string): boolean => {
    const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
    return allPages.some((page) => {
      const stripped = paramStrippedPrefix(page.path);
      return (
        stripped !== undefined &&
        (normalized === stripped || normalized.startsWith(stripped) || stripped.startsWith(normalized))
      );
    });
  };
  type NavigateTarget = { kind: 'literal' | 'prefix'; value: string };
  const collectNavigateTargets = (node: unknown, out: NavigateTarget[]): void => {
    if (!Array.isArray(node)) return;
    if (node[0] === 'navigate') {
      const target = node[1];
      if (
        typeof target === 'string' &&
        target.length > 0 &&
        !target.startsWith('@') &&
        !target.startsWith('?') &&
        !/^https?:\/\//.test(target)
      ) {
        out.push({ kind: 'literal', value: target });
      } else if (
        Array.isArray(target) &&
        target[0] === 'str/concat' &&
        typeof target[1] === 'string' &&
        target[1].startsWith('/')
      ) {
        out.push({ kind: 'prefix', value: target[1] });
      }
    }
    for (const child of node) collectNavigateTargets(child, out);
  };
  for (const orb of schema.orbitals) {
    for (const trait of orb.traits ?? []) {
      if (!isInlineTrait(trait)) continue;
      const seen = new Set<string>();
      for (const arm of trait.stateMachine?.transitions ?? []) {
        const targets: NavigateTarget[] = [];
        for (const effect of arm.effects ?? []) collectNavigateTargets(effect, targets);
        for (const target of targets) {
          const declared = target.kind === 'literal' ? isPathDeclared(target.value) : isPrefixDeclared(target.value);
          if (declared) continue;
          const dedupeKey = `${target.kind}:${target.value}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          findings.push({
            check: 'navigate-target-undeclared',
            severity: 'warning',
            orbital: orb.name,
            trait: trait.name,
            message:
              `${trait.name} navigates to '${target.value}' but no page in this app declares that path (or its ` +
              `parameterized prefix) — the affordance is structurally wired but lands on a 404`,
            suggestion: `declare a page at '${target.value}', or point the navigate effect at an existing page path`,
          });
        }
      }
    }
  }

  // --- page-absent-from-nav ---------------------------------------------
  // `href` extraction reuses the same structural descriptor-array parse
  // `descriptorEvents` already applies to `itemActions`: any array whose
  // entries are objects carrying the field counts, regardless of which
  // trait/config key holds it — no hardcoded `navItems` name list.
  const navHrefs = new Set<string>();
  const collectHrefs = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const href of descriptorEvents(node, 'href')) navHrefs.add(href);
      for (const child of node) collectHrefs(child);
      return;
    }
    if (typeof node !== 'object') return;
    for (const value of Object.values(node as Record<string, unknown>)) collectHrefs(value);
  };
  for (const orb of schema.orbitals) {
    for (const trait of orb.traits ?? []) {
      if (!isInlineTrait(trait)) continue;
      if (trait.config) collectHrefs(trait.config);
      for (const transition of trait.stateMachine?.transitions ?? []) {
        for (const effect of transition.effects ?? []) {
          if (Array.isArray(effect) && effect[0] === 'render-ui' && effect[2] != null) collectHrefs(effect[2]);
        }
      }
    }
  }
  // Only meaningful once the app demonstrably USES the navItems convention
  // (at least one page is reachable through one) — an app with no navItems
  // array anywhere (a registry atom, a chrome-less test fixture) hasn't opted
  // into nav-driven reachability at all, so every page reading "absent" would
  // be noise, not a finding.
  if (navHrefs.size > 0) {
    for (const orb of schema.orbitals) {
      for (const page of inlinePages(orb)) {
        if (page.path === '/') continue; // the app's default route is reached without a nav link
        if (pathSegments(page.path).some((segment) => segment.startsWith(':'))) continue; // parameterized detail page
        if (navHrefs.has(page.path)) continue;
        findings.push({
          check: 'page-absent-from-nav',
          severity: 'warning',
          orbital: orb.name,
          trait: page.name,
          message:
            `page '${page.path}' is declared but appears in no navItems array in this app — a viewer has no link ` +
            `that reaches it`,
          suggestion:
            `add {href: '${page.path}', label, icon} to the AppLayout navItems, or remove the page if it is ` +
            `intentionally sub-navigation`,
        });
      }
    }
  }

  const errors = findings.filter((finding) => finding.severity === 'error').length;
  const warnings = findings.length - errors;
  return { findings, errors, warnings };
}
