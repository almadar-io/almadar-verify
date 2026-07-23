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
 *  - `listens-source-never-emits` — a `listens { A.EVENT -> X }` route whose
 *    source trait exists but never produces EVENT (not in its emits
 *    contract, no effect `emit:` option, no `action:`/`itemActions`
 *    affordance) — the std-cicd wrong-source-listener class.
 *  - `payload-starved-route` — a route delivering EVENT to a listener whose
 *    own contract for the triggered event requires payload fields the
 *    source's declared emit sites cannot supply (std-lms header
 *    "Edit Selected" emitting `EDIT_COURSE` with no `id` while the modal
 *    contract demands `id: string!`).
 *  - `unclaimed-main-writer` — a page-declared trait that renders slot `main`
 *    but is referenced by no bound sibling's `@trait.X` embed (render trees
 *    or config slots like `contentTrait`/`idleContent`). A healthy page has
 *    exactly one unclaimed main-writer root (the shell/composer chain);
 *    every extra root paints a second, stacked UI below the composed tree
 *    (std-accounting `/entries`: two ledger apps on one page). This is the
 *    claim-graph form of the v1-falsified ">1 boot writers" candidate — the
 *    naive count flagged the audited-good shell+claimed-content convention;
 *    counting only UNCLAIMED writers does not (see
 *    `Almadar_Verification_Gaps.md` V-WIRING-LINT-STRAY-WRITER-NEEDS-SLOT-OUTLET-CONTRACT).
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
import { collectTraitEmbedAdjacency, isInlineTrait, isPageReference } from '@almadar/core';
import { collectEffectEmittedEvents } from '../planner/internal/effect-emits.js';

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
  check: 'client-unbound-state-machine' | 'listens-source-never-emits' | 'payload-starved-route' | 'unclaimed-main-writer';
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

/** True when any transition/tick/initial effect of the trait writes the
 *  `main` slot (`['render-ui', 'main', …]`). */
function writesMainSlot(trait: Trait): boolean {
  const effectLists: ReadonlyArray<ReadonlyArray<Effect> | undefined> = [
    ...(trait.stateMachine?.transitions ?? []).map((transition) => transition.effects),
    ...(trait.ticks ?? []).map((tick) => tick.effects),
    trait.initialEffects,
  ];
  for (const effects of effectLists) {
    for (const effect of effects ?? []) {
      if (Array.isArray(effect) && effect[0] === 'render-ui' && effect[1] === 'main') return true;
    }
  }
  return false;
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
        const mapped = new Set(supplied);
        for (const [fromField, toField] of Object.entries(listen.payloadMapping ?? {})) {
          if (supplied.has(fromField)) mapped.add(toField);
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
    for (const page of pages) {
      const pageTraitNames = new Set((page.traits ?? []).map((pageTrait) => pageTrait.ref));
      const claimed = new Set<string>();
      for (const name of pageTraitNames) {
        for (const child of adjacency.get(name) ?? []) claimed.add(child);
      }
      const roots: string[] = [];
      for (const name of pageTraitNames) {
        if (claimed.has(name)) continue;
        const trait = traits.get(name);
        if (trait === undefined) continue;
        if (writesMainSlot(trait)) roots.push(name);
      }
      for (const root of roots.slice(1)) {
        findings.push({
          check: 'unclaimed-main-writer',
          severity: 'error',
          orbital: orb.name,
          trait: root,
          message:
            `page "${page.path}": ${root} renders slot 'main' but no bound trait on the page embeds it — ` +
            `it paints a second, stacked UI next to ${roots[0]} (unclaimed main-writer)`,
          suggestion:
            `embed <trait.${root} /> in the composer's render or a config slot (contentTrait/idleContent), ` +
            `or remove ${root} from the page decl if it only hosts dialogs/logic`,
        });
      }
    }

  }

  const errors = findings.filter((finding) => finding.severity === 'error').length;
  const warnings = findings.length - errors;
  return { findings, errors, warnings };
}
