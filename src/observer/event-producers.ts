/**
 * `event-producers` — shared event-production analysis over a trait's IR:
 * what events a trait can actually fire (via effects, rendered
 * affordances, or config-driven item actions) and what payload fields a
 * given production site supplies. Pure structural facts, not lint
 * findings — split out of the retired JS static wiring lint (P3-L4)
 * because `click-wiring-audit.ts`, `probe-listen-cascades.ts`,
 * `plugin-wiring-lint.ts` and `plan-user-crud-flow.ts` all need one or
 * more of them independently of any lint.
 *
 * @packageDocumentation
 */

import type {
  AnyPatternConfig,
  Effect,
  EventPayload,
  RenderBinding,
  ResolvedPatternProps,
  SExpr,
  Trait,
  TraitConfigValue,
  Transition,
} from '@almadar/core';
import { eventKeyPropsOf, eventListPropsOf } from '@almadar/core';
import { collectEffectEmittedEvents } from '../planner/internal/effect-emits.js';

/** Every IR value shape the walkers below traverse: S-expressions (state
 *  machines), call-site config values, render-ui pattern payloads, and
 *  emit payloads. All are recursive JSON-shaped core types; object nodes
 *  iterate via the same record reinterpretation core's own
 *  `collectTraitRefsFromValue` uses. */
type ScanNode =
  | SExpr
  | TraitConfigValue
  | AnyPatternConfig
  | ResolvedPatternProps
  | RenderBinding
  | EventPayload
  | undefined;

/** Payload field names the source trait can supply for `event`, from every
 *  declared production site: its emits contract's payloadSchema, explicit
 *  `['emit', event, {…}]` effects, and `itemActions` entries (which deliver
 *  the native `{id, row}` payload per the DataGrid/browse contract).
 *
 *  Reused verbatim by `plugin-wiring-lint.ts`'s `lintPluginWiring` to
 *  compute what a plugin's emit site actually supplies toward a
 *  cross-registry host/capability listener — no second copy. */
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

/** An action-descriptor array is recognised STRUCTURALLY, not by name: a
 *  config array whose entries are objects carrying an `event` string is what
 *  the substrate turns into bus-emitting affordances. That is the source tag.
 *  Where a node declares a `type:`, `eventListPropsOf` stays authoritative,
 *  because the registry is the only thing that knows a descriptor's event
 *  field is named something other than `event`.
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
 *  resolved call site actually wires up. */
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

/** Every event the trait can produce, by any declared mechanism — used by
 *  `probe-listen-cascades.ts`'s "can the source produce it at all" check. */
export function producibleEvents(trait: Trait): Set<string> {
  const out = liveProducibleEvents(trait);
  for (const emit of trait.emits ?? []) out.add(emit.event);
  return out;
}
