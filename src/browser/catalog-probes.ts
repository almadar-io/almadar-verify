/**
 * Catalog-level probes for VG4 / VG11a / VG11b / VG11c.
 *
 * These primitives operate on the raw SExpr `effects` arrays that .orb
 * transitions carry. Both runtime-verify (CatalogTransition) and
 * orbital-verify-unified (UnifiedTransition, once enriched with raw
 * effects) pass a {@link TransitionLike} into these helpers, so the
 * binding / cascade / mutation logic lives in one place.
 *
 * The upstream SchemaWalker-based {@link probeBindingsAfterTransition}
 * in `binding-assertions.ts` is kept for callers that already have a
 * SchemaWalker handy; this module is the direct-effect-array companion
 * tooling reaches for when walking catalog schemas without first
 * constructing a walker.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';

// ── Shared transition shape ────────────────────────────────────────────

/**
 * Minimal surface both runtime-verify's `CatalogTransition` and
 * orbital-verify-unified's `UnifiedTransition` satisfy. `from` may be a
 * single source state or an array (the `*` / multi-state transition
 * case); helpers only read `effects`, so the from-state union is
 * declared for type ergonomics at call sites that do use it.
 */
export interface TransitionLike {
  from: string | readonly string[];
  to: string;
  event: string;
  effects: readonly unknown[];
}

/**
 * Minimal trait surface for cascade cross-reference lookups. Both
 * tools' trait shapes have a `name` plus an optional `listens` array
 * of `{ event, triggers }` entries. `transitions` and `linkedEntity`
 * are optional — supplied when VG11d's `probeCascadeFlowDelta` needs to
 * find the downstream persist effects and the entity they mutate.
 */
export interface TraitListenerLike {
  name: string;
  listens?: readonly { event?: string; triggers?: string }[];
  transitions?: readonly TransitionLike[];
  linkedEntity?: string;
}

// ── VG11a — Binding-to-DOM ─────────────────────────────────────────────

export interface CatalogBinding {
  /** Original binding string ("@config.title", "@entity.name", ...). */
  path: string;
  /** Root discriminator. */
  root: 'config' | 'payload' | 'entity';
  /** Segments after the root. For "@config.a.b" → ["a", "b"]. */
  segments: string[];
  /** Slot the binding renders into. */
  slot: string;
  /** Pattern type at the binding site ('typography', 'icon', ...). */
  patternType: string;
  /** Prop key that holds the binding ('content', 'title', ...). */
  propKey: string;
}

/**
 * Prop keys whose values carry event-emit payloads, not render-text
 * bindings. `actionPayload: {id: "@payload.id"}` threads `@payload.id`
 * into the emitted event's payload — it's NOT a promise to render the
 * id as DOM text. A binding found under one of these keys should not
 * be subject to VG11a's DOM search.
 */
const EVENT_ARG_PROP_KEYS = new Set([
  'actionPayload',
  'payload',
  'submitPayload',
  'eventPayload',
]);

/**
 * Walk a render-ui config tree and collect every `@root.path` binding.
 * Used to enumerate what a transition "promises" to render so the
 * probe can check the promised values are in the DOM.
 *
 * Skips recursion into props listed in {@link EVENT_ARG_PROP_KEYS} —
 * those carry payload bindings forwarded to emitted events, not text
 * that's supposed to show up in the DOM.
 */
export function collectCatalogBindings(
  node: unknown,
  slot: string,
  rootPatternType: string,
  out: CatalogBinding[],
): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) collectCatalogBindings(item, slot, rootPatternType, out);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const patternType = typeof obj.type === 'string' ? obj.type : rootPatternType;
  for (const [key, value] of Object.entries(obj)) {
    if (EVENT_ARG_PROP_KEYS.has(key)) continue;
    if (typeof value === 'string' && value.startsWith('@')) {
      const match = /^@(config|payload|entity)(?:\.(.+))?$/.exec(value);
      if (match) {
        const root = match[1] as 'config' | 'payload' | 'entity';
        const tail = match[2] ?? '';
        const segments = tail.length > 0 ? tail.split('.') : [];
        out.push({ path: value, root, segments, slot, patternType, propKey: key });
      }
      continue;
    }
    if (value !== null && typeof value === 'object') {
      collectCatalogBindings(value, slot, patternType, out);
    }
  }
}

/** Walk a nested value by dotted path segments. Returns undefined on miss. */
export function pickBySegments(root: unknown, segments: readonly string[]): unknown {
  let current: unknown = root;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      // Bind `.data` arrays to their first row — matches the rendering
      // path where `@entity.X` resolves against the first/current row.
      current = current[0];
      if (current === null || current === undefined) return undefined;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/** Stringify a resolved binding value for DOM search. */
export function valueToText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return null; // Arrays / objects aren't rendered as leaf text; skip.
}

export interface BindingProbeResult {
  path: string;
  slot: string;
  patternType: string;
  propKey: string;
  passed: boolean;
  detail: string;
}

/**
 * Probe the DOM for each binding's expected value.
 *
 * Config bindings resolve against the supplied `traitConfig` (usually
 * the catalog trait's call-site config). Payload bindings resolve
 * against `snapshot.lastPayload`. Entity bindings resolve against
 * `snapshot.data[linkedEntity]` (first row).
 */
export async function probeBindingsForTransition(
  page: Page,
  _traitName: string,
  transition: TransitionLike,
  traitConfig: Record<string, unknown> | undefined,
  snapshot: { lastPayload?: unknown; data: Record<string, unknown> } | undefined,
  linkedEntity: string | undefined,
): Promise<BindingProbeResult[]> {
  const bindings: CatalogBinding[] = [];
  for (const effect of transition.effects) {
    if (!Array.isArray(effect) || effect[0] !== 'render-ui') continue;
    const slot = typeof effect[1] === 'string' ? effect[1] : 'unknown';
    const config = effect[2];
    const topType = typeof (config as { type?: unknown } | null)?.type === 'string'
      ? (config as { type: string }).type
      : 'unknown';
    collectCatalogBindings(config, slot, topType, bindings);
  }

  const results: BindingProbeResult[] = [];
  for (const binding of bindings) {
    let expected: unknown;
    let resolveDetail: string;
    if (binding.root === 'config') {
      expected = pickBySegments(traitConfig, binding.segments);
      resolveDetail = 'from trait config';
    } else if (binding.root === 'payload') {
      expected = pickBySegments(snapshot?.lastPayload, binding.segments);
      resolveDetail = 'from lastPayload';
    } else {
      const entityRows = linkedEntity ? snapshot?.data?.[linkedEntity] : undefined;
      expected = pickBySegments(entityRows, binding.segments);
      resolveDetail = `from data[${linkedEntity ?? '?'}]`;
    }

    const expectedText = valueToText(expected);
    if (expectedText === null) {
      // Non-scalar expected value — skip without DOM search. Surface a
      // specific detail when the binding root is `payload` and the
      // resolved value is object-typed (the typical G29 case): payload
      // schemas like `SAVE { data: object }` carry structured rows the
      // verifier shouldn't try to render-as-text. Distinguishing this
      // from "no value yet" makes triage faster. (G29 — Phase B.2.)
      const isObjectish = expected !== null && typeof expected === 'object';
      const detail = isObjectish && binding.root === 'payload'
        ? `skipped — payload binding "${binding.path}" is object-typed (not text-renderable)`
        : isObjectish
          ? `skipped — ${binding.root} binding "${binding.path}" resolved to object/array (not text-renderable)`
          : `skipped — expected value not resolvable (${resolveDetail})`;
      results.push({
        path: binding.path,
        slot: binding.slot,
        patternType: binding.patternType,
        propKey: binding.propKey,
        passed: true,
        detail,
      });
      continue;
    }

    // G39 / Phase B.6: poll the DOM for up to 2s before declaring the
    // text missing. The fetch effect that populates `entity.<field>` may
    // not have settled when the probe first reads — particularly for
    // bindings against an entity loaded asynchronously after a transition
    // (e.g. AgentMemoryThread `entity.totalSteps` after the success
    // emit). Substring match logic is correct; the original synchronous
    // read just raced the React commit. Resolve `false` if the deadline
    // passes without finding the text.
    const pollDeadline = Date.now() + 2000;
    let found = false;
    while (Date.now() < pollDeadline) {
      found = await page.evaluate(({ slot, text }) => {
        const scope = document.getElementById(`slot-${slot}`) ?? document.body;
        if (scope.textContent?.includes(text)) return true;
        const fieldEls = scope.querySelectorAll('[data-field]');
        for (const el of fieldEls) {
          if ((el.textContent ?? '').includes(text)) return true;
          if ((el as HTMLInputElement).value === text) return true;
        }
        const inputs = scope.querySelectorAll('input, textarea, select');
        for (const el of inputs) {
          if ((el as HTMLInputElement).value === text) return true;
        }
        return false;
      }, { slot: binding.slot, text: expectedText });
      if (found) break;
      await page.waitForTimeout(100);
    }

    results.push({
      path: binding.path,
      slot: binding.slot,
      patternType: binding.patternType,
      propKey: binding.propKey,
      passed: found,
      detail: found
        ? `${binding.path}="${expectedText}" found in slot`
        : `${binding.path}="${expectedText}" NOT found in #slot-${binding.slot} (${resolveDetail})`,
    });
  }
  return results;
}

// ── VG11b / VG11c — Mutation delta ────────────────────────────────────

export interface MutationEffect {
  kind: 'persist-create' | 'persist-update' | 'persist-delete' | 'fetch';
  entity: string;
}

/** Walk a transition's effects for persist/fetch operations. */
export function collectMutationEffects(effects: readonly unknown[]): MutationEffect[] {
  const out: MutationEffect[] = [];
  for (const effect of effects) {
    if (!Array.isArray(effect)) continue;
    const op = effect[0];
    if (op === 'persist' && typeof effect[1] === 'string' && typeof effect[2] === 'string') {
      const action = effect[1];
      const entity = effect[2];
      if (action === 'create') out.push({ kind: 'persist-create', entity });
      else if (action === 'update') out.push({ kind: 'persist-update', entity });
      else if (action === 'delete') out.push({ kind: 'persist-delete', entity });
    } else if (op === 'fetch' && typeof effect[1] === 'string') {
      out.push({ kind: 'fetch', entity: effect[1] });
    }
  }
  return out;
}

export interface MutationCheckResult {
  kind: MutationEffect['kind'];
  entity: string;
  baseline: number;
  after: number;
  delta: number;
  passed: boolean;
  detail: string;
}

/**
 * Per-trait entity row counts. Each trait that carries `data[entity]`
 * contributes its own count; stale traits coexist with freshly-refetched
 * ones post-cascade. The probe passes if **any** trait reports the
 * expected delta — a single aggregator (min or max) picks the wrong
 * trait in one direction (min hides creates, max hides deletes).
 */
export type PerTraitEntityCounts = ReadonlyMap<string, readonly number[]>;

/**
 * Pick the representative count for display in pass/fail detail. For
 * growth (create) the best witness is the largest trait; for shrink
 * (delete) the smallest; for "any count" (update, fetch) just pick one.
 */
function pickWitness(counts: readonly number[], direction: 'grow' | 'shrink' | 'any'): number {
  if (counts.length === 0) return 0;
  if (direction === 'grow') return Math.max(...counts);
  if (direction === 'shrink') return Math.min(...counts);
  return counts[0] ?? 0;
}

function toArray(v: number | readonly number[] | undefined): readonly number[] {
  if (v === undefined) return [];
  return typeof v === 'number' ? [v] : v;
}

/**
 * For each mutation effect in the transition, compute the expected
 * delta and compare to the actual post-settle count. Baselines are
 * captured by the caller BEFORE the event is dispatched.
 *
 * Accepts per-trait count arrays OR a single aggregated count (legacy
 * callers). With arrays, the probe passes if ANY trait reports the
 * expected delta — avoids false negatives when one trait has a stale
 * cache and another just refetched.
 */
export function probeMutationDelta(
  transition: TransitionLike,
  snapshotsBefore: ReadonlyMap<string, number | readonly number[]>,
  snapshotsAfter: ReadonlyMap<string, number | readonly number[]>,
): MutationCheckResult[] {
  const effects = collectMutationEffects(transition.effects);
  const results: MutationCheckResult[] = [];
  for (const eff of effects) {
    const beforeCounts = toArray(snapshotsBefore.get(eff.entity));
    const afterCounts = toArray(snapshotsAfter.get(eff.entity));
    let passed: boolean;
    let detail: string;
    let baseline: number;
    let after: number;
    if (eff.kind === 'persist-create') {
      // Before: use min (lowest baseline → most room to grow).
      // After: use max (any trait that grew is a witness).
      baseline = pickWitness(beforeCounts, 'shrink');
      after = pickWitness(afterCounts, 'grow');
      const delta = after - baseline;
      passed = delta >= 1;
      detail = passed
        ? `${eff.entity} row count grew ${baseline}→${after}`
        : `${eff.entity} expected +1 after persist-create, got ${delta}`;
      results.push({ kind: eff.kind, entity: eff.entity, baseline, after, delta, passed, detail });
    } else if (eff.kind === 'persist-delete') {
      // Before: use max (highest baseline). After: use min (any trait that shrank).
      baseline = pickWitness(beforeCounts, 'grow');
      after = pickWitness(afterCounts, 'shrink');
      const delta = after - baseline;
      passed = delta <= -1;
      detail = passed
        ? `${eff.entity} row count shrank ${baseline}→${after}`
        : `${eff.entity} expected -1 after persist-delete, got ${delta}`;
      results.push({ kind: eff.kind, entity: eff.entity, baseline, after, delta, passed, detail });
    } else if (eff.kind === 'persist-update') {
      baseline = pickWitness(beforeCounts, 'any');
      after = pickWitness(afterCounts, 'any');
      const delta = after - baseline;
      passed = delta === 0;
      detail = passed
        ? `${eff.entity} row count stable at ${after} across update`
        : `${eff.entity} expected 0 delta on persist-update, got ${delta}`;
      results.push({ kind: eff.kind, entity: eff.entity, baseline, after, delta, passed, detail });
    } else {
      baseline = pickWitness(beforeCounts, 'any');
      after = pickWitness(afterCounts, 'any');
      const delta = after - baseline;
      passed = after >= 0;
      detail = `${eff.entity} after fetch: ${after} row(s)`;
      results.push({ kind: eff.kind, entity: eff.entity, baseline, after, delta, passed, detail });
    }
  }
  return results;
}

// ── VG4 — Cascade count ────────────────────────────────────────────────

export interface EmitDeclaration {
  /** Event name the effect promises to emit on success. */
  success?: string;
  /** Event name the effect promises to emit on failure (skipped in this gate). */
  failure?: string;
}

/** Walk a transition's effects and collect every `emit: {...}` option. */
export function collectEmitDeclarations(effects: readonly unknown[]): EmitDeclaration[] {
  const out: EmitDeclaration[] = [];
  for (const effect of effects) {
    if (!Array.isArray(effect)) continue;
    const last = effect[effect.length - 1];
    if (last && typeof last === 'object' && !Array.isArray(last)) {
      const obj = last as Record<string, unknown>;
      const emit = obj.emit;
      if (emit && typeof emit === 'object' && !Array.isArray(emit)) {
        const e = emit as Record<string, unknown>;
        const decl: EmitDeclaration = {};
        if (typeof e.success === 'string') decl.success = e.success;
        if (typeof e.failure === 'string') decl.failure = e.failure;
        if (decl.success !== undefined || decl.failure !== undefined) {
          out.push(decl);
        }
      }
    }
  }
  return out;
}

export interface CascadeCheckResult {
  emitEvent: string;
  listeningTrait: string;
  baselineCount: number;
  afterCount: number;
  passed: boolean;
  detail: string;
}

/**
 * For each emit declaration on the transition, find every trait that
 * listens for the emitted event and assert its cascadeReceived gained
 * at least one matching entry since the pre-transition snapshot.
 */
export function probeCascadeCount(
  transition: TransitionLike,
  traits: readonly TraitListenerLike[],
  snapshotsBefore: ReadonlyMap<string, number>,
  snapshotsAfter: ReadonlyMap<string, readonly { event: string }[]>,
): CascadeCheckResult[] {
  const emits = collectEmitDeclarations(transition.effects);
  const results: CascadeCheckResult[] = [];
  for (const emit of emits) {
    if (emit.success === undefined) continue;
    const event = emit.success;
    const listeners = traits.filter((t) => {
      const listens = t.listens;
      return Array.isArray(listens) && listens.some((l) => l.event === event);
    });
    for (const listener of listeners) {
      const baselineKey = `${listener.name}|${event}`;
      const baselineCount = snapshotsBefore.get(baselineKey) ?? 0;
      const received = snapshotsAfter.get(listener.name) ?? [];
      const matching = received.filter((r) => r.event === event).length;
      const gained = matching - baselineCount;
      results.push({
        emitEvent: event,
        listeningTrait: listener.name,
        baselineCount,
        afterCount: matching,
        passed: gained >= 1,
        detail: gained >= 1
          ? `${listener.name} received ${event} (+${gained})`
          : `${listener.name} listens for ${event} but cascadeReceived didn't grow (baseline: ${baselineCount}, after: ${matching})`,
      });
    }
  }
  return results;
}

// ── VG11d — Cascade-flow delta (end-to-end user-click mutation delta) ──

/**
 * Per-listener cascade result. One entry per (listener trait, triggered
 * event) pair that a clicked event fed into, with the full mutation-delta
 * breakdown for every persist/fetch effect on the triggered transition.
 */
export interface CascadeFlowDeltaResult {
  /** The user-click event at the source of the cascade. */
  clickedEvent: string;
  /** The trait whose `listens` matched `clickedEvent`. */
  listeningTrait: string;
  /** The trigger event dispatched on the listening trait. */
  triggeredEvent: string;
  /** Row-count deltas for every persist/fetch effect on the triggered transition. */
  mutations: MutationCheckResult[];
  /** Overall pass iff every mutation delta passed (or there were none). */
  passed: boolean;
  detail: string;
}

/**
 * VG11d — assert that a user click produces the end-to-end row-count
 * delta the schema promises through a cross-trait `listens` cascade.
 *
 * Frame-level gates (VG4 `probeCascadeCount`, VG11b `probeMutationDelta`)
 * each verify one step of the chain in isolation:
 * - VG4: "listener received the emit event"
 * - VG11b: "the listener's transition produced +1/-1 rows when the
 *   engine dispatched the triggered event directly"
 *
 * Neither catches the case exposed by std-cart's Save/Confirm-Remove: a
 * real user click on event `E` cascades into another trait's `T` whose
 * transition has `(persist create/delete ...)`, but the row never
 * appears/disappears because `T`'s payload is empty, or the persist
 * short-circuits, or the downstream refetch never fires. `probeMutationDelta`
 * explicitly SKIPs cascade-triggered frames (engine-synthesized payloads
 * are unreliable), so the only way to test this path is to let the user
 * click do the work and measure the delta.
 *
 * Algorithm:
 * 1. For each listener trait with `listens[].event === clickedEvent`,
 *    look up the transition whose `event === listens[].triggers`.
 * 2. Pull the mutation effects off that transition via `collectMutationEffects`.
 * 3. Poll `readAfterCounts` up to `pollTimeoutMs` for the expected
 *    delta (+1 on create, -1 on delete). Break early when all mutations
 *    pass.
 * 4. Run `probeMutationDelta` with the final snapshot; return one
 *    result per (listener, triggered-event) pair.
 *
 * Callers supply:
 * - `readAfterCounts`: closure that reads the post-click entity count
 *   map. Typically wraps `readTraitSnapshots(page)` + max across all
 *   traits' `data[entity].length`.
 * - `baselineCounts`: pre-click entity count map, captured right
 *   before the click. Same shape as `readAfterCounts`'s return.
 */
export async function probeCascadeFlowDelta(
  input: {
    clickedEvent: string;
    listenerTraits: readonly TraitListenerLike[];
    baselineCounts: ReadonlyMap<string, number | readonly number[]>;
    readAfterCounts: () => Promise<Map<string, number | readonly number[]>>;
    wait: (ms: number) => Promise<void>;
    pollTimeoutMs?: number;
    pollIntervalMs?: number;
  },
): Promise<CascadeFlowDeltaResult[]> {
  const pollTimeoutMs = input.pollTimeoutMs ?? 10_000;
  const pollIntervalMs = input.pollIntervalMs ?? 250;

  // Resolve: which (listener, triggered-transition) pairs need a delta check?
  type Pair = {
    listenerName: string;
    triggeredEvent: string;
    transition: TransitionLike;
    mutations: MutationEffect[];
  };
  const pairs: Pair[] = [];
  for (const trait of input.listenerTraits) {
    if (!Array.isArray(trait.listens) || !Array.isArray(trait.transitions)) continue;
    for (const listen of trait.listens) {
      if (listen.event !== input.clickedEvent) continue;
      if (typeof listen.triggers !== 'string') continue;
      const triggeredEvent = listen.triggers;
      for (const tx of trait.transitions) {
        if (tx.event !== triggeredEvent) continue;
        const mutations = collectMutationEffects(tx.effects);
        if (mutations.length === 0) continue;
        pairs.push({ listenerName: trait.name, triggeredEvent, transition: tx, mutations });
      }
    }
  }

  if (pairs.length === 0) return [];

  // Poll for all pairs to pass, break early when every pair's mutations pass.
  let afterCounts = await input.readAfterCounts();
  const deadline = Date.now() + pollTimeoutMs;
  const allPassed = (): boolean =>
    pairs.every((p) =>
      probeMutationDelta(p.transition, input.baselineCounts, afterCounts).every((r) => r.passed),
    );
  // Diagnostic trace: VG11d failures were impossible to debug without
  // seeing the count-per-poll. Stored on the result so the caller can
  // emit it alongside the failure detail; drives triage between
  // "cascade never fired" vs "reducer dropped the update" vs "snapshot
  // bridge returned stale data."
  const trace: Array<{ t: number; counts: Record<string, number | readonly number[]> }> = [];
  const snapshot = (): void => {
    trace.push({
      t: Date.now(),
      counts: Object.fromEntries(afterCounts),
    });
  };
  snapshot();
  while (!allPassed() && Date.now() < deadline) {
    await input.wait(pollIntervalMs);
    afterCounts = await input.readAfterCounts();
    snapshot();
  }

  // Final result per pair.
  const results: CascadeFlowDeltaResult[] = [];
  for (const pair of pairs) {
    const mutationResults = probeMutationDelta(pair.transition, input.baselineCounts, afterCounts);
    const allOk = mutationResults.every((r) => r.passed);
    const summary = mutationResults
      .map((r) => `${r.kind} ${r.entity}: ${r.detail}`)
      .join('; ');
    const traceLabel = allOk
      ? ''
      : ` | baseline=${JSON.stringify(Object.fromEntries(input.baselineCounts))} poll=${trace.length} samples last3=${trace.slice(-3).map((s) => JSON.stringify(s.counts)).join('→')}`;
    results.push({
      clickedEvent: input.clickedEvent,
      listeningTrait: pair.listenerName,
      triggeredEvent: pair.triggeredEvent,
      mutations: mutationResults,
      passed: allOk,
      detail: allOk
        ? `cascade ${input.clickedEvent} → ${pair.listenerName}.${pair.triggeredEvent}: ${summary}`
        : `cascade ${input.clickedEvent} → ${pair.listenerName}.${pair.triggeredEvent} failed: ${summary}${traceLabel}`,
    });
  }
  return results;
}

// ── VG11f — Entity row content assertion ─────────────────────────────

/**
 * Minimal entity-field surface both tools' catalogs satisfy. `required`
 * is the declaration that drives the assertion; `values` narrows enums;
 * `default` exempts the field when no caller-supplied data is present.
 */
export interface EntityFieldLike {
  name: string;
  type: string;
  required?: boolean;
  values?: readonly string[];
  default?: unknown;
}

export interface FieldContentCheck {
  field: string;
  present: boolean;
  value: unknown;
  detail: string;
}

export interface EntityRowContentResult {
  entity: string;
  rowId: unknown;
  passed: boolean;
  checks: FieldContentCheck[];
  detail: string;
}

/**
 * VG11f — assert a newly-created entity row carries non-empty values
 * for every declared required field. Runs AFTER a persist-create
 * cascade passes (VG11d's `grow` verdict) so the row we check is the
 * one the caller actually created, not a pre-existing seed row.
 *
 * Motivation: VG11b/VG11d count +1 on create but don't look AT the
 * row. A trait that emits SAVE with an empty/partial payload still
 * grows the count by 1 but produces a blank card in the DataGrid —
 * user-visible regression invisible to count-based gates. Mirror
 * orbital-verify's content-verification semantics in the runtime path
 * so runtime-verify catches the same class of bug.
 *
 * The caller supplies:
 * - `entityName`: which entity to check (e.g. "CartItem")
 * - `entityFields`: the entity's declared fields (from catalog)
 * - `rowsAfter`: the trait's `data[entity]` array AFTER cascade
 * - `rowsBefore` (optional): the same array BEFORE cascade — when
 *   provided, we identify the new row as the one whose id isn't in
 *   rowsBefore. When omitted, we check the last row (best-effort).
 *
 * Skipped / empty fields that do NOT fail the check:
 * - `id`, `createdAt`, `updatedAt` (framework-managed)
 * - Fields with a declared `default` (the schema has already said "OK at
 *   this value" — `pendingId: string = ""` declares empty as acceptable,
 *   so the probe must not flip around and fail because "" is empty)
 * - Fields where `required: false`
 */
export function probeEntityRowContent(input: {
  entityName: string;
  entityFields: readonly EntityFieldLike[];
  rowsAfter: readonly Record<string, unknown>[];
  rowsBefore?: readonly Record<string, unknown>[];
}): EntityRowContentResult {
  const beforeIds = new Set<unknown>(
    (input.rowsBefore ?? [])
      .map((r) => r.id)
      .filter((id) => id !== undefined && id !== null),
  );
  const newRows = input.rowsAfter.filter((r) => !beforeIds.has(r.id));
  const newRow = newRows[newRows.length - 1] ?? input.rowsAfter[input.rowsAfter.length - 1];

  if (!newRow) {
    return {
      entity: input.entityName,
      rowId: undefined,
      passed: false,
      checks: [],
      detail: `${input.entityName}: no row found to check (rowsAfter is empty)`,
    };
  }

  const FRAMEWORK = new Set(['id', 'createdAt', 'updatedAt']);
  const checks: FieldContentCheck[] = [];
  for (const field of input.entityFields) {
    if (FRAMEWORK.has(field.name)) continue;
    if (field.required === false) continue;
    // Fields with a declared default are acceptable at that default, so
    // whatever value is on the row is schema-conformant. Don't probe.
    if (field.default !== undefined) continue;
    // Fields with no declared requiredness and no default are best-effort
    // optional — also skip.
    if (!field.required) continue;

    const value = newRow[field.name];
    const isEmpty =
      value === null ||
      value === undefined ||
      (typeof value === 'string' && value.trim().length === 0);
    const present = !isEmpty;
    checks.push({
      field: field.name,
      present,
      value,
      detail: present
        ? `${field.name}=${typeof value === 'string' ? `"${String(value).slice(0, 40)}"` : typeof value}`
        : `${field.name} MISSING (declared type=${field.type}${field.required ? ', required' : ''})`,
    });
  }

  const failed = checks.filter((c) => !c.present);
  return {
    entity: input.entityName,
    rowId: newRow.id,
    passed: failed.length === 0,
    checks,
    detail: failed.length === 0
      ? `new ${input.entityName} row has all ${checks.length} declared field(s): ${checks.map((c) => c.detail).join(', ')}`
      : `new ${input.entityName} row (id=${String(newRow.id)}) missing ${failed.length}/${checks.length} field(s): ${failed.map((c) => c.detail).join(', ')}`,
  };
}
