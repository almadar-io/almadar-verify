/**
 * `affordance-disabled` — C1-V15 item B: which of a trait's rendered
 * action affordances (a `Button`'s `action=`, or an `itemActions`/
 * `browseItemActions`-shaped descriptor entry's `event`) declares a
 * `disabled` expression, so `pickTargetRow` can exclude a candidate row
 * whose affordance would be a structural no-op click (std-helpdesk's
 * `RATE` button: `disabled={(if (and ["=", ?data.status, resolved] (not
 * ?data.csatScore)) false true)}` — enabled only for a resolved, unrated
 * ticket; clicking it while disabled is a DOM ✓ / emit ✗ false pass).
 *
 * The render-ui tree may name the affordance INLINE (an object literal
 * carrying `action`/`disabled` directly) or via an embedded-trait
 * reference (`"@trait.<Name>"` — `collectEmbeddedTraitReferrers`'s own
 * token shape) — an embedded `Button.traits.ButtonRender` call site
 * stamps its OWN config (`config.action.default` / `config.disabled.
 * default`) instead of appearing inline, and — because it's a COMPOSED
 * trait — the compiler's inline-hoisting rewrites any `?<field>`
 * reference from the ENCLOSING transition's payload into
 * `@callsitePayload.<field>` (verified against std-helpdesk's resolved
 * `.orb`: `TicketDetail`'s render-ui embeds `"@trait.InlineButtonRender7"`,
 * whose OWN `config.disabled.default` reads `@callsitePayload.data.status`
 * — see `@almadar/core`'s `CORE_BINDINGS` / `embedded-trait-config.ts`).
 * Both shapes are resolved here so the caller gets one uniform
 * `{expr, bindingRoot}` pair regardless of which one applied — never
 * guessed from the affordance's NAME, always read off the declared tree.
 *
 * Pure. No `Page`, no driver, no evaluator (evaluation itself is
 * `tick()`'s job — the one place that already imports `@almadar/evaluator`
 * for guard truth).
 *
 * @packageDocumentation
 */

import { collectBindings } from '@almadar/core';
import type { OrbitalSchema, SExpr, Trait } from '@almadar/core';
import { eachInlineTrait } from './orbital-walk.js';

export interface AffordanceDisabledExpr {
  expr: SExpr;
  /** Which context field the expr's bindings read the row from —
   *  `'callsitePayload'` for an embedded-trait call site's hoisted
   *  config, `'payload'` for an inline render node. */
  bindingRoot: 'payload' | 'callsitePayload';
}

/** An inline render node (a literal object in the tree) whose own `action`
 *  or descriptor `event` field names `eventName`. */
function findInlineActionNode(node: SExpr, eventName: string): Readonly<Record<string, SExpr>> | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findInlineActionNode(item, eventName);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const obj = node as Readonly<Record<string, SExpr>>;
  if (obj['action'] === eventName || obj['event'] === eventName) return obj;
  for (const value of Object.values(obj)) {
    const found = findInlineActionNode(value, eventName);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Every `@trait.<Name>` embed token referenced anywhere in the tree. */
function collectTraitEmbedNames(node: SExpr): string[] {
  const out: string[] = [];
  walk(node);
  function walk(n: SExpr): void {
    if (typeof n === 'string') {
      const match = /^@trait\.([A-Za-z0-9_]+)$/.exec(n);
      if (match !== null) out.push(match[1]);
      return;
    }
    if (Array.isArray(n)) {
      for (const item of n) walk(item);
      return;
    }
    if (n !== null && typeof n === 'object') {
      for (const value of Object.values(n)) walk(value);
    }
  }
  return out;
}

/** Which context field an expr's OWN bindings read the row from — derived
 *  from the expr itself, never assumed from which shape produced it. */
function bindingRootOf(expr: SExpr): 'payload' | 'callsitePayload' | undefined {
  for (const binding of collectBindings(expr)) {
    if (binding.startsWith('@callsitePayload.')) return 'callsitePayload';
    if (binding.startsWith('@payload.')) return 'payload';
  }
  return undefined;
}

function findTraitByName(orbital: OrbitalSchema, name: string): Trait | undefined {
  for (const { trait } of eachInlineTrait(orbital)) {
    if (trait.name === name) return trait;
  }
  return undefined;
}

/**
 * Find the `disabled` expression governing the affordance that fires
 * `eventName`, as rendered by `renderingTrait` (C1-V9 item C's own
 * "whichever trait actually paints the button" resolution — reused
 * verbatim by callers, not re-derived here). Returns `undefined` when the
 * affordance has no `disabled` prop at all (never disabled), its
 * `disabled` is a bare boolean literal (a literal `true` is the
 * pre-existing `crud-affordance-absent` finding's job, not this filter's;
 * a plain `false` is simply "never disabled"), or the expr's own bindings
 * don't resolve to a row-scoped context this filter can evaluate.
 */
export function findAffordanceDisabledExpr(
  orbital: OrbitalSchema,
  renderingTrait: Trait,
  eventName: string,
): AffordanceDisabledExpr | undefined {
  if (renderingTrait.stateMachine === undefined) return undefined;

  for (const transition of renderingTrait.stateMachine.transitions) {
    for (const effect of transition.effects ?? []) {
      if (!Array.isArray(effect) || effect[0] !== 'render-ui') continue;
      const tree = effect[2] as SExpr;
      const candidates: SExpr[] = [];

      const inline = findInlineActionNode(tree, eventName);
      const inlineDisabled = inline?.['disabled'];
      if (inlineDisabled !== undefined && Array.isArray(inlineDisabled)) {
        candidates.push(inlineDisabled);
      }

      for (const embedName of collectTraitEmbedNames(tree)) {
        const embedded = findTraitByName(orbital, embedName);
        const actionDefault = embedded?.config?.['action']?.default;
        if (embedded === undefined || actionDefault !== eventName) continue;
        const disabledDefault = embedded.config?.['disabled']?.default;
        if (Array.isArray(disabledDefault)) candidates.push(disabledDefault as SExpr);
      }

      for (const candidate of candidates) {
        const bindingRoot = bindingRootOf(candidate);
        if (bindingRoot !== undefined) return { expr: candidate, bindingRoot };
      }
    }
  }
  return undefined;
}
