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
 *
 * @packageDocumentation
 */

import type {
  AnyPatternConfig,
  Effect,
  EventPayload,
  Orbital,
  OrbitalPage,
  OrbitalSchema,
  RenderBinding,
  ResolvedPatternProps,
  SExpr,
  Trait,
  TraitConfigValue,
} from '@almadar/core';
import { collectTraitConfigRefAdjacency, collectTraitEmbedAdjacency, isContentBodyPattern, isInlineTrait, isMainSlotRenderUi, isPageReference } from '@almadar/core';
import { collectEffectEmittedEvents, collectFetchSuccessEvents } from '../planner/internal/effect-emits.js';

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
    | 'listens-source-never-emits'
    | 'payload-starved-route'
    | 'unclaimed-main-writer';
  severity: WiringLintSeverity;
  orbital: string;
  trait: string;
  message: string;
  /** Ready-to-apply fix direction, phrased against the `.lolo` source. */
  suggestion: string;
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

/** Events reachable as `action:` fields anywhere in the trait's render-ui
 *  trees or config values (inline buttons scope their emit to the composer). */
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
    const itemActions = record['itemActions'];
    if (Array.isArray(itemActions)) {
      for (const entry of itemActions) {
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
          const event = asRecordNode(entry)['event'];
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
            `add an INIT re-entry to '${state}' in ${name} mirroring the loading state's own ` +
            `INIT (fetch + loading render), the shape std-browse uses`,
        });
      }
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
        // payloadMapping is {targetField: "@payload.<sourceField>" | literal}
        // (the runtime's application shape, OrbitalServerRuntime ~:1257) — a
        // literal value supplies the field unconditionally.
        const mapped = new Set(supplied);
        for (const [toField, expr] of Object.entries(listen.payloadMapping ?? {})) {
          if (expr.startsWith('@payload.')) {
            if (supplied.has(expr.slice('@payload.'.length))) mapped.add(toField);
          } else {
            mapped.add(toField);
          }
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
    const channelAdj = collectTraitConfigRefAdjacency(orb);
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

  const errors = findings.filter((finding) => finding.severity === 'error').length;
  const warnings = findings.length - errors;
  return { findings, errors, warnings };
}
