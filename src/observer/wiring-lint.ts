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
 *    shell's catalog — healthcare `/patients/upload`, ecommerce `/checkout`,
 *    both audited-good). Placeholder-box main-writes (modal cleanup), atomic
 *    chrome, and claimed embeds are excluded. Supersedes the v1-falsified
 *    ">1 boot writers" candidate (see `Almadar_Verification_Gaps.md`
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
import { ownerFieldsFromSchema } from '@almadar/core/mock';
import { collectBindings, collectTraitConfigRefAdjacency, collectTraitEmbedAdjacency, eventKeyPropsOf, eventListPropsOf, isContentBodyPattern, isContentBodyPatternType, isContentMainWriter, isInlineTrait, resolvePageContentOwner, isMainSlotRenderUi, isPageReference, traitDeclaresConfigForward } from '@almadar/core';
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
    | 'unscoped-owned-entity';
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
    // that provably carried the defect.
    const labelled = LABEL_KEYS.some((key) => {
      const value = record[key];
      return typeof value === 'string' && value.length > 0 && !value.startsWith('@') && !value.startsWith('?');
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

/** Config keys whose arrays carry `{ event, label, … }` action descriptors
 *  that the substrate turns into bus-emitting affordances, for nodes that
 *  carry no resolvable `type:` (bare config descriptors). `itemActions` is
 *  the grid/list contract; `agendaItemActions` (std-calendar agenda rows) and
 *  `detailActions` (std-browse master-detail record pane) forward to the same
 *  DOM-click emit path but are NOT registry-declared as `kind: "event-list"`
 *  (`S-EVENT-LIST-PROPS-UNDECLARED-IN-REGISTRY`), so they stay listed here.
 *  Where a node does declare a `type:`, `eventListPropsOf` is authoritative
 *  and covers the registry's `leftActions`/`rightActions`/`topBarActions`
 *  siblings this list never knew about. */
const ACTION_DESCRIPTOR_KEYS = ['itemActions', 'agendaItemActions', 'detailActions'] as const;

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
    const keys = new Set<string>([...ACTION_DESCRIPTOR_KEYS, ...declared.keys()]);
    for (const key of keys) {
      const eventField = declared.get(key) ?? 'event';
      let actions = record[key];
      // Resolved orbs carry config values knob-wrapped ({ default, type });
      // the descriptor array lives under `default`.
      if (actions !== null && typeof actions === 'object' && !Array.isArray(actions)) {
        actions = asRecordNode(actions)['default'];
      }
      if (!Array.isArray(actions)) continue;
      for (const entry of actions) {
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
          const event = asRecordNode(entry)[eventField];
          if (typeof event === 'string' && event.length > 0) out.add(event);
        }
      }
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
    for (const traitRef of orb.traits ?? []) {
      if (isInlineTrait(traitRef)) traits.set(traitRef.name, traitRef);
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
        }
      }
      if (persisting.size === before) break;
    }
    // Only labels that PROMISE durability. "Cancel"/"Close"/"Back" abort a flow
    // and are correct with no persist; including them made the first draft of
    // this check flag 10 controls in one file, all of them fine.
    const MUTATING_LABEL = /^(archive|publish|unpublish|deactivate|retire|void|revoke|issue)\b/i;
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

    // --- listens-source-never-emits + payload-starved-route --------------
    for (const [listenerName, listener] of traits) {
      for (const listen of listener.listens ?? []) {
        const source = listen.source;
        if (source === undefined || !('kind' in source) || source.kind !== 'trait') continue;
        const sourceName = source.trait;
        if (typeof sourceName !== 'string') continue;
        const sourceTrait = traits.get(sourceName);
        if (sourceTrait === undefined) {
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
    // dedicated-feature convention (healthcare /patients/upload, ecommerce
    // /checkout — a page-mounted feature complementing the shell's catalog,
    // both audited-good), so this check REPORTS (warning) for human/runtime
    // arbitration — `slot:contention` in the client console + page captures
    // are the arbiters. Modals (placeholder-box main-writes), atomic chrome,
    // and claimed embeds are excluded by construction.
    const claimedByBound = new Set<string>();
    for (const [source, targets] of adjacency) {
      if (!bound.has(source)) continue;
      for (const target of targets) claimedByBound.add(target);
    }
    for (const page of pages) {
      let channelBody = false;
      for (const [source, targets] of channelAdj) {
        if (!bound.has(source)) continue;
        for (const target of targets) {
          const targetTrait = traits.get(target);
          if (targetTrait !== undefined && isContentMainWriter(targetTrait)) {
            channelBody = true;
            break;
          }
        }
        if (channelBody) break;
      }
      if (!channelBody) continue;
      for (const pageTrait of page.traits ?? []) {
        const name = pageTrait.ref;
        if (claimedByBound.has(name)) continue;
        if ((channelAdj.get(name)?.size ?? 0) > 0) continue;
        const trait = traits.get(name);
        if (trait === undefined || !isContentMainWriter(trait)) continue;
        findings.push({
          check: 'unclaimed-main-writer',
          severity: 'warning',
          orbital: orb.name,
          trait: name,
          message:
            `page "${page.path}": ${name} renders a content body into slot 'main' while the page's content ` +
            `channel already supplies one — a second, stacked UI if this is not a deliberate dedicated-feature page`,
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

  const errors = findings.filter((finding) => finding.severity === 'error').length;
  const warnings = findings.length - errors;
  return { findings, errors, warnings };
}
