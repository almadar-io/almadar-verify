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
 *  - `orbital-config-knob-unforwarded` (retired 2026-09-12 → duplicate of the
 *    compiler's `ORB_O_CONFIG_DEAD_KNOB`, `orbital_config.rs::validate_orbital_config_forwarding`,
 *    which already runs this exact `published_knobs` closure as a hard error).
 *  - `identity-roster-unwritable` (warning) — the app declares an
 *    `[identity]` entity but no transition anywhere reaches a
 *    `persist create` on it: the roster the app's personas map onto has no
 *    write path, so users can never be added from inside the app (the
 *    read-only identity-directory class, 2026-08-19: 46 carriers).
 *  - `client-unbound-state-machine` (retired 2026-09-12 → `ORB_CIRCUIT_CLIENT_UNBOUND_STATE_MACHINE`
 *    in `orb validate`, `closed_circuit.rs::validate_client_bound_state_machines`).
 *  - `steady-state-no-init-reentry` (retired 2026-09-12 → `ORB_CIRCUIT_STEADY_STATE_NO_INIT_REENTRY`
 *    in `orb validate`, `phases/validation/async_results.rs::validate_steady_state_no_init_reentry`
 *    — promoted from warning to error per the 0/0 ruling; the JS check's one documented false
 *    positive, std-app-search's `results` state (2026-07-25 calibration), is exempted by the SAME
 *    declared fact the port reads: `statesWithInit` is keyed on an INIT arm's `from` regardless of
 *    its `to`, and `results` already declares its own `INIT -> idle` re-entry arm).
 *  - `async-result-deaf-target` (retired 2026-09-12 → `ORB_CIRCUIT_ASYNC_RESULT_DEAF_TARGET`
 *    in `orb validate`, `phases/validation/async_results.rs::validate_async_result_deaf_target`
 *    — promoted from warning to error per the 0/0 ruling).
 *  - `listens-source-never-emits` (retired 2026-09-12 → duplicate of the
 *    compiler's `ORB_X_LISTEN_SOURCE_UNRESOLVED`,
 *    `cross_orbital/listens.rs::validate_listens_integrity`, which reads the
 *    same three production sites — `emits[]`, effect `emit:` options, and
 *    rendered/item-action affordances — as an error).
 *  - `listener-affordance-removed-by-config` (warning) — a `listens { A.EVENT
 *    -> X }` route whose source trait's own `emits[]` contract DOES declare
 *    EVENT (so the compiler's `ORB_X_LISTEN_SOURCE_UNRESOLVED` already
 *    passed it — the route is structurally legal), but no LIVE mechanism at
 *    this call site — effect
 *    `emit:`, rendered affordance, config-driven item action, or an embedded
 *    child's own producer up the embed-host chain — actually fires it: a
 *    config override (e.g. `itemActions` narrowed to VIEW-only) silenced the
 *    contract's only producer. The listener is reachable in principle but
 *    dead in practice at this configuration.
 *  - `payload-starved-route` (retired 2026-09-12 → `ORB_LISTEN_ROUTE_STARVES_REQUIRED_FIELD`
 *    in `orb validate`).
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
 *  - `dead-lifecycle-action` (retired 2026-09-12 → `ORB_RENDER_ACTION_LIFECYCLE_EVENT`
 *    in `orb validate`).
 *  - `dead-bodiless-action` (retired 2026-09-12 → `ORB_CIRCUIT_DEAD_BODILESS_ACTION`
 *    in `orb validate`, `closed_circuit.rs::validate_dead_bodiless_actions`).
 *  - `dead-lifecycle-emit` (retired 2026-09-12 → `ORB_CIRCUIT_LIFECYCLE_EMIT_UNDELIVERED`
 *    in `orb validate`, `closed_circuit.rs::validate_lifecycle_emit_effects`).
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
 *  - `navigate-target-undeclared` (retired 2026-09-12 → duplicate of the
 *    compiler's `ORB_EFF_NAVIGATE_TARGET_UNREACHABLE`,
 *    `phases/validation/effect/navigate.rs::validate_navigate`, confirmed at
 *    parity on all three target shapes — cross-orbital literal, `str/concat`
 *    prefix, `http(s)://` external — as an error).
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
 *  - `page-path-duplicate` (retired 2026-09-12 → duplicate of the compiler's
 *    `ORB_P_DUPLICATE_PATH`, `page.rs::validate_page_path_uniqueness`, which
 *    already runs the same `:name`-segment normalization as a hard error).
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
 *  - `plugin-emit-no-host-listener`, `plugin-emit-payload-mismatch`,
 *    `plugin-listen-source-not-host` — CROSS-REGISTRY siblings of the retired
 *    `listens-source-never-emits`/`payload-starved-route` classes above, emitted by
 *    `lintPluginWiring` in `plugin-wiring-lint.ts` (a separate export, not a
 *    case in `lintWiring`: this schema is single-orbital, that one is
 *    plugin-schema-vs-N-target-schemas). See that file's header doc for the
 *    full contract.
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
  RenderUiPayload,
  ResolvedPatternProps,
  SExpr,
  Trait,
  TraitConfigValue,
  Transition,
} from '@almadar/core';
import { identityEntityName, identityEntityNames, ownerFieldsFromSchema } from '@almadar/core/mock';
import { collectTraitConfigRefAdjacency, collectTraitEmbedAdjacency, eventKeyPropsOf, eventListPropsOf, getPatternFieldsContract, isContentBodyPatternType, isContentMainWriter, isInlineTrait, isValueInputPattern, reduceToOwners, resolvePageContentOwner, isMainSlotRenderUi, isPageReference, traitDeclaresConfigForward } from '@almadar/core';
import { LIFECYCLE_EVENTS as RuntimeLifecycleEvents } from '@almadar/runtime';
import { collectEffectEmittedEvents } from '../planner/internal/effect-emits.js';
import { embedHostsOf } from './click-wiring-audit.js';
import { traitOrEmbedHostProduces } from './probe-listen-cascades.js';

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
    | 'groupby-enum-column-gap'
    | 'listener-affordance-removed-by-config'
    | 'unclaimed-main-writer'
    | 'viewer-stranded'
    | 'embedded-sibling-single-referrer'
    | 'unscoped-owned-entity'
    | 'app-theme-divergent'
    | 'identity-roster-unwritable'
    | 'page-absent-from-nav'
    | 'relation-field-rendered-raw'
    | 'plugin-emit-no-host-listener'
    | 'plugin-emit-payload-mismatch'
    | 'plugin-listen-source-not-host';
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
 *  the native `{id, row}` payload per the DataGrid/browse contract).
 *
 *  Exported for `plugin-wiring-lint.ts` (`lintPluginWiring`), which reuses
 *  it unchanged to compute what a plugin's emit site actually supplies
 *  toward a cross-registry host/capability listener — no second copy. */
export function suppliedPayloadFields(trait: Trait, event: string): Set<string> | 'runtime-forwarded' {
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
function scanRenderActionEvents(node: ScanNode, out: Set<string>): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) scanRenderActionEvents(child, out);
    return;
  }
  if (typeof node !== 'object') return;
  const record = asRecordNode(node);
  const action = record['action'];
  if (typeof action === 'string' && action.length > 0) out.add(action);
  const patternType = record['type'];
  if (typeof patternType === 'string') {
    for (const prop of eventKeyPropsOf(patternType)) {
      for (const leaf of conditionalLeafValues(record[prop])) {
        if (typeof leaf === 'string' && leaf.length > 0) out.add(leaf);
      }
    }
  }
  for (const value of Object.values(record)) scanRenderActionEvents(value, out);
}

/** Same contract as {@link collectRenderActionEvents}, scoped to ONE
 *  transition's own `render-ui` effects — the per-transition slice
 *  `probeListenCascades` needs to pick a dispatchable arm, rather than the
 *  whole-trait union every OTHER caller here wants. */
export function renderActionEventsOf(transition: Transition): Set<string> {
  const out = new Set<string>();
  for (const effect of transition.effects ?? []) {
    if (Array.isArray(effect) && effect[0] === 'render-ui' && effect[2] != null) {
      scanRenderActionEvents(effect[2], out);
    }
  }
  return out;
}

function collectRenderActionEvents(trait: Trait): Set<string> {
  const out = new Set<string>();
  for (const transition of trait.stateMachine?.transitions ?? []) {
    for (const event of renderActionEventsOf(transition)) out.add(event);
  }
  if (trait.config) scanRenderActionEvents(trait.config, out);
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
 *   3. a NON-INLINE sibling embed, which brings its own surface. This
 *      includes a DECLARED ref trait the inline-only `traits` map cannot
 *      hold: an unresolved ref means content-unknown, never content-empty,
 *      so the check may not assert "no data surface" over it
 *      (SCAN-LINT-UNRESOLVED-REF-1 — a composed `ref:
 *      RecordDetail.traits.RecordItemDetail` embed false-positived a
 *      factory-clean std-notes).
 */
function mainWriteOffersAWayOn(
  body: ScanNode,
  traits: ReadonlyMap<string, Trait>,
  declaredTraitNames: ReadonlySet<string>,
): boolean {
  const visited = new Set<string>();
  const LABEL_KEYS = ['label', 'actionLabel', 'submitLabel', 'cancelLabel'] as const;
  let found = false;

  const scan = (node: ScanNode): void => {
    if (found || node === null || node === undefined) return;
    if (typeof node === 'string') {
      if (!node.startsWith('@trait.')) return;
      const name = node.slice('@trait.'.length);
      const embedded = traits.get(name);
      if (embedded === undefined) {
        if (declaredTraitNames.has(name)) found = true;
        return;
      }
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
 *  routing both skip them). The owner is `@almadar/runtime`'s own
 *  `LIFECYCLE_EVENTS` (`StateMachineCore.ts`), already re-exported and
 *  consumed by `@almadar/ui` — this set wraps it rather than repeating the
 *  event names. */
const LIFECYCLE_EVENTS: ReadonlySet<string> = new Set(RuntimeLifecycleEvents);

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
  // A conditional (`(if cond A B)`) list contributes the UNION of its
  // branches — only one renders at a time, but either is a live emitter
  // (mirrors the compiler's conditional_leaf_values, 2026-08-30).
  if (isConditionalNode(value)) {
    return [...descriptorEvents(value[2], eventField), ...descriptorEvents(value[3], eventField)];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const event = asRecordNode(entry)[eventField];
    if (typeof event === 'string' && event.length > 0) out.push(event);
  }
  return out;
}

/** `["if", cond, then, else?]` — the lowered shape of a `(if …)` config value. */
function isConditionalNode(value: unknown[]): boolean {
  return value[0] === 'if' && value.length >= 3 && value.length <= 4;
}

/** The value itself, or — for a conditional — every branch leaf, recursively. */
function conditionalLeafValues(value: unknown): unknown[] {
  if (Array.isArray(value) && isConditionalNode(value)) {
    return [...conditionalLeafValues(value[2]), ...(value.length === 4 ? conditionalLeafValues(value[3]) : [])];
  }
  return [value];
}

/**
 * Events declared in `itemActions`-shaped config arrays anywhere in the
 * trait's config tree (`[{ event, label, … }]`) — the deterministic
 * "is this a ROW action" detector: an event here is rendered once per row
 * (a data-grid/list `itemActions`/`browseItemActions` knob), never a plain
 * single button elsewhere on the page. Exported so `plan-user-crud-flow.ts`
 * (C1-V9 item C) can classify a `crud-edit`/`crud-delete` step's DOM
 * affordance the same deterministic way this observer already does,
 * instead of a second hand-rolled check — one owner, per the project's
 * no-duplicates rule.
 */
export function configItemActionEvents(trait: Trait): Set<string> {
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

/** Literal `['emit', eventName, payload?]` effect tuples — the form
 *  `collectEffectEmittedEvents` doesn't cover (it only reads the
 *  `{emit: {success, failure}}` fetch/persist options-object shape). Shared
 *  by both scan sites below so a transition's and a tick's explicit emits
 *  are read by the one walk, not two copies that could drift. */
function explicitEmitEvents(effects: ReadonlyArray<Effect> | undefined): Set<string> {
  const out = new Set<string>();
  for (const effect of effects ?? []) {
    if (Array.isArray(effect) && effect[0] === 'emit' && typeof effect[1] === 'string') out.add(effect[1]);
  }
  return out;
}

/** Every event a LIVE mechanism on the trait currently produces — effects,
 *  rendered affordances, and config-driven item actions. Deliberately
 *  EXCLUDES the trait's own `emits[]` contract: that array declares what the
 *  trait is PERMITTED to emit under some configuration, not what a specific
 *  resolved call site actually wires up. Split out of {@link producibleEvents}
 *  as the building block `listener-affordance-removed-by-config` needs — a
 *  contract entry with no live producer behind it. */
function liveProducibleEvents(trait: Trait): Set<string> {
  const out = new Set<string>();
  // `TraitTick.effects` fires on a scheduler, not a state-machine transition
  // (`std-*` clock/timer generics), but is the same `{effects?: Effect[]}`
  // shape — scanned alongside transitions, not as a separate walk.
  const effectSources: ReadonlyArray<{ effects?: ReadonlyArray<Effect> }> = [
    ...(trait.stateMachine?.transitions ?? []),
    ...(trait.ticks ?? []),
  ];
  for (const event of collectEffectEmittedEvents(effectSources)) out.add(event);
  for (const source of effectSources) {
    for (const event of explicitEmitEvents(source.effects)) out.add(event);
  }
  for (const event of collectRenderActionEvents(trait)) out.add(event);
  for (const event of configItemActionEvents(trait)) out.add(event);
  return out;
}

/** Every event the trait can produce, by any declared mechanism — exported
 *  for `probe-listen-cascades.ts`'s "can the source produce it at all" check,
 *  the same oracle this lint's own `listener-affordance-removed-by-config`
 *  static check uses, so a probed vs. a statically-linted source never
 *  disagree. */
export function producibleEvents(trait: Trait): Set<string> {
  const out = liveProducibleEvents(trait);
  for (const emit of trait.emits ?? []) out.add(emit.event);
  return out;
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

export function lintWiring(schema: OrbitalSchema): WiringLintResult {
  const findings: WiringLintFinding[] = [];
  // Whole-schema embed-host map — `listener-affordance-removed-by-config`
  // credits an embedded child's own live producer up its embed-host chain,
  // the same contract `probe-listen-cascades.ts` and `click-wiring-audit.ts`
  // already share.
  const embedHosts = embedHostsOf(schema);

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
          if (mainWriteOffersAWayOn(body as ScanNode, traits, declaredTraitNames)) continue;
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

    // (detail-panel-back-in-actions retired 2026-08-21 — the temporary
    // migration aid burned down to 0 corpus-wide in the UX campaign.)

    // --- listener-affordance-removed-by-config ------------------------
    // A `listens { A.EVENT -> X }` route whose source trait/event pair is
    // unresolved (missing source trait, or the event genuinely unproduced)
    // is the compiler's `ORB_X_LISTEN_SOURCE_UNRESOLVED`
    // (`listens-source-never-emits`, retired 2026-09-12) — this walk only
    // needs to skip those shapes to reach the ones IT owns: a source that
    // resolves in CONTRACT but has been silenced at THIS call site.
    for (const [listenerName, listener] of traits) {
      for (const listen of listener.listens ?? []) {
        const source = listen.source;
        if (source === undefined || !('kind' in source) || source.kind !== 'trait') continue;
        const sourceName = source.trait;
        if (typeof sourceName !== 'string') continue;
        const sourceTrait = traits.get(sourceName);
        if (sourceTrait === undefined) continue;
        const sourceEvents = producible.get(sourceName) ?? new Set<string>();
        if (!sourceEvents.has(listen.event)) continue;

        // sourceEvents.has(listen.event) is true here (the block above
        // already continued on the miss), so the CONTRACT permits sourceName
        // to produce listen.event. `sourceEvents` is `producibleEvents`,
        // which folds the contract's `emits[]` in unconditionally — check
        // separately whether any LIVE mechanism (effect emit, rendered
        // affordance, config item action, or an embedded child's own
        // producer) still backs it at this call site.
        const emitsContractHasEvent = (sourceTrait.emits ?? []).some((emit) => emit.event === listen.event);
        if (
          emitsContractHasEvent &&
          !traitOrEmbedHostProduces(sourceTrait, sourceName, listen.event, embedHosts, traits, liveProducibleEvents)
        ) {
          findings.push({
            check: 'listener-affordance-removed-by-config',
            severity: 'warning',
            orbital: orb.name,
            trait: listenerName,
            message:
              `listens route ${sourceName}.${listen.event} -> ${listen.triggers}: ${sourceName}'s emits contract ` +
              `declares ${listen.event}, but no live effect, rendered affordance, or config item action at this ` +
              `call site produces it — a config override (e.g. itemActions/browseItemActions narrowed) likely ` +
              `removed the only producer`,
            suggestion: `restore ${listen.event} to ${sourceName}'s active affordance config, or drop the ${listenerName} route if the removal is intentional`,
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
  // transition ever `persist`s (create, update, OR delete) has no write
  // path at all: users can never be added, edited, or removed from inside
  // the app, even though every read surface looks complete. Narrower than
  // "no `persist create`" alone — a roster row is always seeded by auth
  // first, so a legitimate write path may be `persist update` ONLY
  // (std-realtime-chat's `OnlinePresence` writes `OnlineUser` — the
  // viewer's own row — via `persist update`, never `create`; a `create`
  // there would collide with the auth-seeded row). Effects are scanned
  // recursively so persists nested in `if` branches count.
  const identityName = identityEntityName(schema);
  if (identityName !== undefined) {
    const touchesIdentity = (node: unknown): boolean => {
      if (!Array.isArray(node)) return false;
      if (
        node[0] === 'persist'
        && (node[1] === 'create' || node[1] === 'update' || node[1] === 'delete')
        && node[2] === identityName
      ) {
        return true;
      }
      return node.some(touchesIdentity);
    };
    let hasWritePath = false;
    for (const orb of schema.orbitals) {
      for (const trait of orb.traits ?? []) {
        if (!isInlineTrait(trait)) continue;
        for (const arm of trait.stateMachine?.transitions ?? []) {
          if ((arm.effects ?? []).some(touchesIdentity)) {
            hasWritePath = true;
            break;
          }
        }
        if (hasWritePath) break;
      }
      if (hasWritePath) break;
    }
    if (!hasWritePath) {
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
            `${identityName} is the app's [identity] roster but no transition ever ` +
            `\`persist\`s it (create, update, or delete) — the roster is read-only, so a ` +
            `signed-in user's own row can never change from inside the app`,
          suggestion:
            `compose a write path into the ${identityName} orbital: an Add affordance emitting ` +
            `CREATE with a \`Modal.traits.ModalRecordModal\` create modal and a persistor trait ` +
            `whose DO_CREATE arm runs \`(persist create ${identityName} ?data)\`, or — when rows are ` +
            `always seeded by auth first — a self-service edit path whose persistor runs ` +
            `\`(persist update ${identityName} ?data)\` against the viewer's own row`,
        });
      }
    }
  }

  // --- page-absent-from-nav ---------------------------------------------
  // `href` extraction reuses the same structural descriptor-array parse
  // `descriptorEvents` already applies to `itemActions`: any array whose
  // entries are objects carrying the field counts, regardless of which
  // trait/config key holds it — no hardcoded `navItems` name list.
  const pathSegments = (path: string): string[] => path.split('/').filter((segment) => segment.length > 0);
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
