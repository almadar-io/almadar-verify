/**
 * Schema walker for verification gates (VG Foundation 2).
 *
 * Given a fully `ResolvedIR`, classifies each trait's events by *who can
 * dispatch them* (UI click vs cross-trait cascade vs server-side emit),
 * extracts declared bindings inside each state's render-ui tree, and
 * identifies mutating effects on each transition. These classifications
 * are the source of truth for VG2 (classification), VG3 (click-path
 * sampling), VG4 (cascade count), VG11a (binding-to-DOM), and VG11c
 * (mutation delta).
 *
 * Pure read-only over the schema — no DOM, no runtime, no side effects.
 * Types flow from `@almadar/core` (ResolvedIR, ResolvedTraitTransition,
 * SExpr) so drift between verifier expectations and the actual schema
 * is impossible by construction.
 *
 * @packageDocumentation
 */

import type {
  ResolvedIR,
  ResolvedTraitTransition,
  SExpr,
} from '@almadar/core';

// ── Event classification ──────────────────────────────────────────────

export type EventKey = string;

export interface EventClassification {
  /**
   * Events the schema declares a UI trigger for (a button with `action`
   * or `event` prop, an itemAction, a form's submit/cancel event, etc.).
   * These are the events the walker should try to click as a sample.
   */
  userDispatchable: Set<EventKey>;
  /**
   * Events this trait receives via a `listens { Source SRC → EVENT }`
   * binding — cascade-triggered, not user-invokable.
   */
  cascadeTriggered: Set<EventKey>;
  /**
   * Events emitted by a server-side effect (`fetch`/`persist`/`call-service`/
   * `ref`) via `emit: { success: "X", failure: "Y" }`. The verifier should
   * check these arrive in the response's `emittedEvents` cascade, not
   * search for a button.
   */
  serverEmitted: Set<EventKey>;
}

// ── Bindings ──────────────────────────────────────────────────────────

export type BindingRoot =
  | 'config'
  | 'payload'
  | 'entity'
  | 'state'
  | 'user'
  | 'item'
  | 'now'
  | 'other';

/**
 * A single `@config.X`/`@payload.X`/`@entity.X` binding resolved in a
 * state's render-ui tree. Callers of VG11a use this to assert the bound
 * value appears in the target DOM element.
 */
export interface SchemaBinding {
  /** Original binding string ("@config.title", "@entity.name", ...). */
  path: string;
  /** Binding root (the word after `@`, before the first dot). */
  root: BindingRoot;
  /** Segments after the root ("config.a.b" → ["a", "b"]). */
  segments: string[];
  /** Slot the binding renders into ('main', 'modal', 'drawer', ...). */
  slot: string;
  /** Pattern type that hosts the binding ('typography', 'data-grid', ...). */
  patternType: string;
  /** Prop key on the host pattern where the binding value lands. */
  propKey: string;
}

// ── Mutating effects ──────────────────────────────────────────────────

export type MutatingEffectKind =
  | 'persist-create'
  | 'persist-update'
  | 'persist-delete'
  | 'set'
  | 'set-dynamic'
  | 'fetch';

/**
 * A transition's data-mutating effect (what VG11c diffs before/after).
 * Non-mutating effects (render-ui, emit, log, notify, navigate) are
 * excluded.
 */
export interface MutatingEffect {
  kind: MutatingEffectKind;
  /** Entity name the effect targets (undefined for set-dynamic with a computed target). */
  entity?: string;
  /** Target binding for set/set-dynamic (e.g. `@entity.pendingId`). */
  target?: SExpr;
  /** Payload / value expression (what gets written). */
  payloadExpr?: SExpr;
}

// ── Walker ────────────────────────────────────────────────────────────

/**
 * Classifies events and extracts bindings + mutations from a ResolvedIR.
 * All methods are pure functions over the schema; construct once per
 * behavior, call as many times as the walker needs.
 */
export class SchemaWalker {
  constructor(private readonly ir: ResolvedIR) {}

  /**
   * Classify every declared event on a trait into user-dispatchable,
   * cascade-triggered, and server-emitted sets. An event may appear in
   * more than one set when it has multiple dispatch paths (e.g. a SAVE
   * button that also receives cascade-triggered saves from a coordinator).
   */
  classifyEvents(traitName: string): EventClassification {
    return {
      userDispatchable: this.userDispatchableEvents(traitName),
      cascadeTriggered: this.cascadeTriggeredEvents(traitName),
      serverEmitted: this.serverEmittedEvents(traitName),
    };
  }

  /** Set of events the UI declares a trigger for, on this trait. */
  userDispatchableEvents(traitName: string): Set<EventKey> {
    const trait = this.ir.traits.get(traitName);
    if (!trait) return new Set();
    const out = new Set<EventKey>();
    for (const transition of trait.transitions) {
      for (const effect of transition.effects) {
        this.collectUIEvents(effect, out);
      }
    }
    return out;
  }

  /** Set of events this trait receives via `listens` triggers. */
  cascadeTriggeredEvents(traitName: string): Set<EventKey> {
    const trait = this.ir.traits.get(traitName);
    if (!trait) return new Set();
    const out = new Set<EventKey>();
    for (const listener of trait.listens) {
      if (listener.triggers && listener.triggers.length > 0) {
        out.add(listener.triggers);
      }
    }
    return out;
  }

  /** Set of events emitted by server-side effects on this trait. */
  serverEmittedEvents(traitName: string): Set<EventKey> {
    const trait = this.ir.traits.get(traitName);
    if (!trait) return new Set();
    const out = new Set<EventKey>();
    for (const transition of trait.transitions) {
      for (const effect of transition.effects) {
        this.collectServerEmits(effect, out);
      }
    }
    return out;
  }

  /**
   * Bindings present in the render-ui tree fired on transitions that
   * apply to `stateName`. A state's rendered slot content comes from
   * the transition INTO that state, so this walks every transition
   * whose `to === stateName` (plus from-side listeners such as `*`).
   */
  bindingsInState(traitName: string, stateName: string): SchemaBinding[] {
    const trait = this.ir.traits.get(traitName);
    if (!trait) return [];
    const out: SchemaBinding[] = [];
    for (const transition of trait.transitions) {
      if (transition.to !== stateName && !this.transitionCanRenderInState(transition, stateName)) {
        continue;
      }
      for (const effect of transition.effects) {
        this.collectRenderUiBindings(effect, out);
      }
    }
    return out;
  }

  /** Parse every data-mutating effect on a transition. */
  mutatingEffects(transition: ResolvedTraitTransition): MutatingEffect[] {
    const out: MutatingEffect[] = [];
    for (const effect of transition.effects) {
      this.collectMutatingEffects(effect, out);
    }
    return out;
  }

  // ── Internals ─────────────────────────────────────────────────────

  /**
   * A render-ui effect inside a same-state transition (from === to === S)
   * also contributes to S's visible content, so include those too.
   */
  private transitionCanRenderInState(
    transition: ResolvedTraitTransition,
    stateName: string,
  ): boolean {
    if (transition.from === '*' && transition.to === stateName) return true;
    if (typeof transition.from === 'string') {
      return transition.from === stateName && transition.to === stateName;
    }
    if (Array.isArray(transition.from)) {
      return transition.from.includes(stateName) && transition.to === stateName;
    }
    return false;
  }

  private collectUIEvents(effect: SExpr, out: Set<EventKey>): void {
    if (!Array.isArray(effect)) return;
    if (effect[0] === 'render-ui' && effect.length >= 3) {
      this.walkUIForEvents(effect[2], out);
    }
  }

  private walkUIForEvents(node: SExpr, out: Set<EventKey>): void {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) this.walkUIForEvents(item, out);
      return;
    }
    const obj = node as Record<string, unknown>;
    const eventKeys = [
      'action',
      'event',
      'submitEvent',
      'cancelEvent',
      'selectEvent',
      'loadMoreEvent',
      'changeEvent',
    ];
    for (const key of eventKeys) {
      const value = obj[key];
      if (typeof value === 'string' && value.length > 0 && !value.startsWith('@')) {
        out.add(value);
      }
    }
    const itemActions = obj.itemActions;
    if (Array.isArray(itemActions)) {
      for (const action of itemActions) {
        if (action && typeof action === 'object' && !Array.isArray(action)) {
          const ev = (action as Record<string, unknown>).event;
          if (typeof ev === 'string' && ev.length > 0 && !ev.startsWith('@')) {
            out.add(ev);
          }
        }
      }
    }
    const children = obj.children;
    if (Array.isArray(children)) {
      for (const child of children) this.walkUIForEvents(child as SExpr, out);
    } else if (children && typeof children === 'object') {
      this.walkUIForEvents(children as SExpr, out);
    }
  }

  private collectServerEmits(effect: SExpr, out: Set<EventKey>): void {
    if (!Array.isArray(effect)) return;
    const op = effect[0];
    if (op !== 'fetch' && op !== 'persist' && op !== 'call-service' && op !== 'ref') {
      return;
    }
    for (const arg of effect) {
      if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
        const maybeEmit = (arg as Record<string, unknown>).emit;
        if (maybeEmit && typeof maybeEmit === 'object' && !Array.isArray(maybeEmit)) {
          const emitObj = maybeEmit as Record<string, unknown>;
          if (typeof emitObj.success === 'string') out.add(emitObj.success);
          if (typeof emitObj.failure === 'string') out.add(emitObj.failure);
        }
      }
    }
  }

  private collectRenderUiBindings(effect: SExpr, out: SchemaBinding[]): void {
    if (!Array.isArray(effect)) return;
    if (effect[0] === 'render-ui' && effect.length >= 3) {
      const slot = typeof effect[1] === 'string' ? effect[1] : 'unknown';
      this.walkUIForBindings(effect[2], slot, 'root', out);
    }
  }

  private walkUIForBindings(
    node: SExpr,
    slot: string,
    parentPatternType: string,
    out: SchemaBinding[],
  ): void {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) this.walkUIForBindings(item, slot, parentPatternType, out);
      return;
    }
    const obj = node as Record<string, unknown>;
    const patternType =
      typeof obj.type === 'string' ? obj.type : parentPatternType;

    for (const [key, val] of Object.entries(obj)) {
      if (key === 'type' || key === 'children') continue;
      if (typeof val === 'string' && val.startsWith('@')) {
        const parsed = this.parseBinding(val);
        if (parsed) {
          out.push({
            path: val,
            root: parsed.root,
            segments: parsed.segments,
            slot,
            patternType,
            propKey: key,
          });
        }
      } else if (val && typeof val === 'object') {
        this.walkUIForBindings(val as SExpr, slot, patternType, out);
      }
    }

    const children = obj.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        this.walkUIForBindings(child as SExpr, slot, patternType, out);
      }
    } else if (children && typeof children === 'object') {
      this.walkUIForBindings(children as SExpr, slot, patternType, out);
    }
  }

  private parseBinding(s: string): { root: BindingRoot; segments: string[] } | null {
    if (!s.startsWith('@')) return null;
    const body = s.slice(1);
    if (body.length === 0) return null;
    const parts = body.split('.');
    const head = parts[0];
    const segments = parts.slice(1);
    const knownRoots: BindingRoot[] = [
      'config',
      'payload',
      'entity',
      'state',
      'user',
      'item',
      'now',
    ];
    if ((knownRoots as string[]).includes(head)) {
      return { root: head as BindingRoot, segments };
    }
    return { root: 'other', segments: [head, ...segments] };
  }

  private collectMutatingEffects(effect: SExpr, out: MutatingEffect[]): void {
    if (!Array.isArray(effect)) return;
    const op = effect[0];
    if (op === 'persist' && effect.length >= 3) {
      const action = effect[1];
      const entity = effect[2];
      const payloadExpr = effect[3] as SExpr | undefined;
      if (typeof action === 'string' && typeof entity === 'string') {
        const kind: MutatingEffectKind | undefined =
          action === 'create'
            ? 'persist-create'
            : action === 'update'
              ? 'persist-update'
              : action === 'delete'
                ? 'persist-delete'
                : undefined;
        if (kind) {
          out.push({ kind, entity, payloadExpr });
        }
      }
      return;
    }
    if (op === 'fetch' && typeof effect[1] === 'string') {
      out.push({ kind: 'fetch', entity: effect[1] as string });
      return;
    }
    if (op === 'set' && effect.length >= 3) {
      out.push({ kind: 'set', target: effect[1], payloadExpr: effect[2] });
      return;
    }
    if (op === 'set-dynamic' && effect.length >= 3) {
      out.push({ kind: 'set-dynamic', target: effect[1], payloadExpr: effect[2] });
      return;
    }
  }
}
