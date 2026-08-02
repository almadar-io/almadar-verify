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
import { collectBindings, collectTraitConfigRefAdjacency, collectTraitEmbedAdjacency, eventKeyPropsOf, eventListPropsOf, isContentBodyPattern, isInlineTrait, isMainSlotRenderUi, isPageReference, traitDeclaresConfigForward } from '@almadar/core';
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

/** True when the trait has a content-grade `main` render anywhere in its
 *  transition/tick/initial effects (descends into `if` branches). The
 *  content-grade classification itself lives in `@almadar/core`
 *  (`isContentBodyPattern`) — single owner, no local lists. */
function isContentMainWriter(trait: Trait): boolean {
  return (
    (trait.stateMachine?.transitions ?? []).some((transition) => writesContentMain(transition.effects)) ||
    (trait.ticks ?? []).some((tick) => writesContentMain(tick.effects)) ||
    writesContentMain(trait.initialEffects)
  );
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
