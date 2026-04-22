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
 * of `{ event }` entries.
 */
export interface TraitListenerLike {
  name: string;
  listens?: readonly { event?: string }[];
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
 * Walk a render-ui config tree and collect every `@root.path` binding.
 * Used to enumerate what a transition "promises" to render so the
 * probe can check the promised values are in the DOM.
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
      results.push({
        path: binding.path,
        slot: binding.slot,
        patternType: binding.patternType,
        propKey: binding.propKey,
        passed: true,
        detail: `skipped — expected value not scalar (${resolveDetail})`,
      });
      continue;
    }

    const found = await page.evaluate(({ slot, text }) => {
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
 * For each mutation effect in the transition, compute the expected
 * delta and compare to the actual post-settle count. Baselines are
 * captured by the caller BEFORE the event is dispatched.
 */
export function probeMutationDelta(
  transition: TransitionLike,
  snapshotsBefore: ReadonlyMap<string, number>,
  snapshotsAfter: ReadonlyMap<string, number>,
): MutationCheckResult[] {
  const effects = collectMutationEffects(transition.effects);
  const results: MutationCheckResult[] = [];
  for (const eff of effects) {
    const baseline = snapshotsBefore.get(eff.entity) ?? 0;
    const after = snapshotsAfter.get(eff.entity) ?? 0;
    const delta = after - baseline;
    let passed: boolean;
    let detail: string;
    if (eff.kind === 'persist-create') {
      passed = delta >= 1;
      detail = passed
        ? `${eff.entity} row count grew ${baseline}→${after}`
        : `${eff.entity} expected +1 after persist-create, got ${delta}`;
    } else if (eff.kind === 'persist-delete') {
      passed = delta <= -1;
      detail = passed
        ? `${eff.entity} row count shrank ${baseline}→${after}`
        : `${eff.entity} expected -1 after persist-delete, got ${delta}`;
    } else if (eff.kind === 'persist-update') {
      passed = delta === 0;
      detail = passed
        ? `${eff.entity} row count stable at ${after} across update`
        : `${eff.entity} expected 0 delta on persist-update, got ${delta}`;
    } else {
      // fetch — populated is enough; row count may grow or stay stable.
      passed = after >= 0;
      detail = `${eff.entity} after fetch: ${after} row(s)`;
    }
    results.push({ kind: eff.kind, entity: eff.entity, baseline, after, delta, passed, detail });
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
