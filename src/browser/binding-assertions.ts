/**
 * Binding-to-DOM assertions (VG11a).
 *
 * Closes the largest class of false-passes on Almadar's verification
 * surface: the schema declares a `@config.X` / `@payload.X` / `@entity.X`
 * binding inside a pattern prop, the state transitions, the snapshot
 * shows the right data in the reducer — but the rendered slot never
 * actually shows the value. Without this gate the walker reports 100%
 * coverage even when users open the app and see a blank card.
 *
 * For each trait the runtime reports via `getTraitSnapshots()`:
 *   1. Compute the bindings the schema says the trait's current state
 *      renders, using {@link SchemaWalker.bindingsInState}.
 *   2. Resolve each binding's expected value:
 *      - `@config.path` → walk `ResolvedTraitBinding.config` on the
 *        trait binding passed in.
 *      - `@payload.path` → walk `snapshot.lastPayload`.
 *      - `@entity.path` → walk the first row of `snapshot.data[<entity>]`.
 *   3. Query the live DOM for that value:
 *      - Scope the search to the slot container (`#slot-<name>` for
 *        portal slots, the whole document for `main`).
 *      - Accept the value if it appears as visible text, a `value=`
 *        on any input/select/textarea, or inside a `[data-field]`
 *        attribute.
 *
 * Pass 1 of this gate is deliberately forgiving on the DOM side:
 * stricter per-pattern selectors can come later without changing the
 * schema-side walk. The goal of this first landing is to catch the
 * "binding silently dropped" case, not to audit every possible markup
 * variation.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import type {
  EventPayloadValue,
  FieldValue,
  ResolvedTraitBinding,
  TraitConfigValue,
} from '@almadar/core';
import type { SchemaWalker, SchemaBinding, BindingRoot } from '../schema/walker.js';
import type { TraitStateSnapshot } from '../runtime/state-bridge.js';
import { PORTAL_SLOTS, isPortalSlot } from './portal-slots.js';

/** Result of probing one binding against the DOM. */
export interface BindingCheck {
  traitName: string;
  /** Original binding string ("@config.title", "@entity.name", ...). */
  path: string;
  root: BindingRoot;
  slot: string;
  patternType: string;
  propKey: string;
  /** The expected value resolved from config/payload/entity. */
  expected: string | null;
  /** Whether the expected value was found somewhere in the slot DOM. */
  passed: boolean;
  /** Why the binding was skipped or why the assertion failed. */
  detail: string;
}

export interface BindingAssertionResult {
  traitName: string;
  currentState: string;
  checks: BindingCheck[];
  allPassed: boolean;
}

/**
 * Resolve and assert every binding the schema says `snapshot.currentState`
 * renders. Returns one {@link BindingCheck} per binding; callers aggregate
 * into their report.
 *
 * Pass the corresponding `ResolvedTraitBinding` (from the page's trait
 * list) so `@config.X` lookups resolve against the caller's config. Pass
 * `null` to skip config bindings (they'll be marked as skipped, not as
 * failures — config without a binding context is legitimately unknowable).
 */
export async function probeBindingsAfterTransition(
  page: Page,
  walker: SchemaWalker,
  snapshot: TraitStateSnapshot,
  traitBinding: ResolvedTraitBinding | null,
): Promise<BindingAssertionResult> {
  const bindings = walker.bindingsInState(snapshot.traitName, snapshot.currentState);
  const checks: BindingCheck[] = [];

  for (const binding of bindings) {
    const resolved = resolveBinding(binding, snapshot, traitBinding);
    if (resolved.kind === 'skip') {
      checks.push({
        traitName: snapshot.traitName,
        path: binding.path,
        root: binding.root,
        slot: binding.slot,
        patternType: binding.patternType,
        propKey: binding.propKey,
        expected: null,
        passed: true,
        detail: `skipped: ${resolved.reason}`,
      });
      continue;
    }
    if (resolved.kind === 'missing') {
      checks.push({
        traitName: snapshot.traitName,
        path: binding.path,
        root: binding.root,
        slot: binding.slot,
        patternType: binding.patternType,
        propKey: binding.propKey,
        expected: null,
        passed: false,
        detail: `expected source absent: ${resolved.reason}`,
      });
      continue;
    }

    const expectedStr = stringifyExpected(resolved.value);
    if (expectedStr === null) {
      checks.push({
        traitName: snapshot.traitName,
        path: binding.path,
        root: binding.root,
        slot: binding.slot,
        patternType: binding.patternType,
        propKey: binding.propKey,
        expected: null,
        passed: true,
        detail: `skipped: resolved value is not directly renderable (${typeof resolved.value})`,
      });
      continue;
    }

    const found = await findInSlot(page, binding.slot, expectedStr);
    checks.push({
      traitName: snapshot.traitName,
      path: binding.path,
      root: binding.root,
      slot: binding.slot,
      patternType: binding.patternType,
      propKey: binding.propKey,
      expected: expectedStr,
      passed: found,
      detail: found
        ? `found "${expectedStr}" in slot "${binding.slot}"`
        : `"${expectedStr}" not found in slot "${binding.slot}" for prop "${binding.propKey}"`,
    });
  }

  return {
    traitName: snapshot.traitName,
    currentState: snapshot.currentState,
    checks,
    allPassed: checks.every((c) => c.passed),
  };
}

// ── Binding resolution ────────────────────────────────────────────────

type Resolved =
  | { kind: 'value'; value: ResolvedValue }
  | { kind: 'skip'; reason: string }
  | { kind: 'missing'; reason: string };

type ResolvedValue = TraitConfigValue | EventPayloadValue | FieldValue;

function resolveBinding(
  binding: SchemaBinding,
  snapshot: TraitStateSnapshot,
  traitBinding: ResolvedTraitBinding | null,
): Resolved {
  if (binding.segments.length === 0) {
    return { kind: 'skip', reason: 'empty binding segments' };
  }
  switch (binding.root) {
    case 'config': {
      if (!traitBinding?.config) {
        return { kind: 'skip', reason: 'no trait binding / config to resolve against' };
      }
      const value = walkPath(traitBinding.config as unknown as Record<string, unknown>, binding.segments);
      if (value === undefined) {
        return { kind: 'missing', reason: `config has no path "${binding.segments.join('.')}"` };
      }
      return { kind: 'value', value: value as ResolvedValue };
    }
    case 'payload': {
      if (!snapshot.lastPayload) {
        return { kind: 'skip', reason: 'snapshot.lastPayload is undefined' };
      }
      const value = walkPath(snapshot.lastPayload as Record<string, unknown>, binding.segments);
      if (value === undefined) {
        return { kind: 'missing', reason: `payload has no path "${binding.segments.join('.')}"` };
      }
      return { kind: 'value', value: value as ResolvedValue };
    }
    case 'entity': {
      const entityName = inferEntityName(traitBinding);
      if (!entityName) {
        return { kind: 'skip', reason: 'no linkedEntity on trait binding' };
      }
      const rows = snapshot.data[entityName];
      if (!rows || rows.length === 0) {
        return { kind: 'skip', reason: `snapshot has no rows for entity "${entityName}"` };
      }
      const row = rows[0];
      const value = walkPath(row as unknown as Record<string, unknown>, binding.segments);
      if (value === undefined) {
        return { kind: 'missing', reason: `entity "${entityName}" row has no path "${binding.segments.join('.')}"` };
      }
      return { kind: 'value', value: value as ResolvedValue };
    }
    default:
      return { kind: 'skip', reason: `binding root "${binding.root}" not yet resolvable` };
  }
}

function inferEntityName(traitBinding: ResolvedTraitBinding | null): string | null {
  if (!traitBinding) return null;
  if (typeof traitBinding.linkedEntity === 'string' && traitBinding.linkedEntity.length > 0) {
    return traitBinding.linkedEntity;
  }
  return null;
}

function walkPath(
  source: Record<string, unknown>,
  segments: string[],
): unknown {
  let cursor: unknown = source;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function stringifyExpected(value: ResolvedValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return null;
}

// ── DOM probe ─────────────────────────────────────────────────────────

/**
 * Look for `expected` inside the DOM subtree that corresponds to the
 * schema slot. Portal slots (`modal`, `drawer`, `toast`, ...) map to
 * `#slot-<name>`; non-portal slots (`main`, section/grid slots) fall
 * back to the whole document.
 */
async function findInSlot(
  page: Page,
  slot: string,
  expected: string,
): Promise<boolean> {
  return page.evaluate(
    ({ slot, expected, portalSlots }) => {
      const container: Element =
        portalSlots.includes(slot)
          ? document.getElementById(`slot-${slot}`) ?? document.body
          : document.body;

      const needle = expected.toLowerCase();

      if ((container.textContent ?? '').toLowerCase().includes(needle)) {
        return true;
      }

      const inputs = container.querySelectorAll<HTMLInputElement>(
        'input, textarea, select',
      );
      for (const input of Array.from(inputs)) {
        if ((input.value ?? '').toLowerCase().includes(needle)) return true;
      }

      const dataNodes = container.querySelectorAll<HTMLElement>('[data-field]');
      for (const node of Array.from(dataNodes)) {
        if ((node.textContent ?? '').toLowerCase().includes(needle)) return true;
        const attr = node.getAttribute('data-value');
        if (attr && attr.toLowerCase().includes(needle)) return true;
      }

      return false;
    },
    { slot, expected, portalSlots: PORTAL_SLOTS as readonly string[] },
  );
}

// Re-export a subset of the schema-walker types so consumers don't need
// to reach into `../schema/walker.js` just to type a check.
export type { SchemaBinding, BindingRoot };

// Internal helper re-export: consumers that need to know whether a slot
// is a portal (to scope their own DOM probes) share the same predicate.
export { isPortalSlot };

/**
 * Assert every binding on every trait in one go. Wraps
 * {@link probeBindingsAfterTransition} for callers that already have
 * the snapshot array + trait-binding lookup in hand.
 */
export async function probeAllTraitBindings(
  page: Page,
  walker: SchemaWalker,
  snapshots: TraitStateSnapshot[],
  traitBindingFor: (traitName: string) => ResolvedTraitBinding | null,
): Promise<BindingAssertionResult[]> {
  const results: BindingAssertionResult[] = [];
  for (const snapshot of snapshots) {
    const binding = traitBindingFor(snapshot.traitName);
    results.push(await probeBindingsAfterTransition(page, walker, snapshot, binding));
  }
  return results;
}
