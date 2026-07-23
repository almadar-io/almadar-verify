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
 * A fourth check (stray page-writer detection, the std-blaz unclaimed-writer
 * class) was calibrated OUT of v1: ">1 boot writers of main per page" flags
 * the audited-good layout+content convention (healthcare `/patients/upload`,
 * helpdesk `/replies`), because a page's main slot legitimately stacks the
 * shell and one content writer. A sound version needs the slot-outlet
 * contract (which named slots a bound tree actually declares outlets for) —
 * recorded in `Almadar_Verification_Gaps.md`.
 *
 * @packageDocumentation
 */

import type { Orbital, OrbitalPage, OrbitalSchema, Trait } from '@almadar/core';
import { collectTraitEmbedAdjacency, isInlineTrait, isPageReference } from '@almadar/core';
import { collectEffectEmittedEvents } from '../planner/internal/effect-emits.js';

export type WiringLintSeverity = 'error' | 'warning';

export interface WiringLintFinding {
  check: 'client-unbound-state-machine' | 'listens-source-never-emits' | 'payload-starved-route';
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
function suppliedPayloadFields(trait: Trait, event: string): Set<string> | 'unknown-any' {
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
  if (!declaredAnywhere && collectRenderActionEvents(trait).has(event)) return 'unknown-any';
  return supplied;
}

/** Events reachable as `action:` fields anywhere in the trait's render-ui
 *  trees or config values (inline buttons scope their emit to the composer). */
function collectRenderActionEvents(trait: Trait): Set<string> {
  const out = new Set<string>();
  const scan = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node) scan(child);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (typeof obj['action'] === 'string' && obj['action'].length > 0) out.add(obj['action']);
    for (const value of Object.values(obj)) scan(value);
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
  const scan = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node) scan(child);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const itemActions = obj['itemActions'];
    if (Array.isArray(itemActions)) {
      for (const entry of itemActions) {
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
          const event = (entry as Record<string, unknown>)['event'];
          if (typeof event === 'string' && event.length > 0) out.add(event);
        }
      }
    }
    for (const value of Object.values(obj)) scan(value);
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
        if (supplied === 'unknown-any') continue;
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
              `{${[...(supplied as Set<string>)].join(', ') || 'nothing'}} — the affordance is payload-starved and can never satisfy the contract`,
            suggestion: `emit ${listen.event} from a row-scoped affordance (itemActions supplies {id, row} natively) or add the missing fields to the emit payload`,
          });
        }
      }
    }

  }

  const errors = findings.filter((finding) => finding.severity === 'error').length;
  const warnings = findings.length - errors;
  return { findings, errors, warnings };
}
