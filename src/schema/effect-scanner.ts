/**
 * Schema effect scanner for entity binding detection.
 *
 * Recursively walks render-ui effect trees to determine what kind of
 * entity data the transition's UI displays. This drives verification
 * gating: we only check for visible field values or row counts when
 * the schema actually declares entity bindings.
 *
 * Binding forms detected:
 *  - S-expression: `['object/get', ['array/first', '@entity'], 'field']`
 *  - String path:  `@entity.field` or `@item.field` in UI tree props
 *  - List binding:  `{ entity: 'EntityName' }` on data-grid / data-list nodes
 *
 * @packageDocumentation
 */

export interface EntityBindingScan {
  /** UI binds individual entity field values (detail view, stat-display, etc.) */
  hasEntityFieldBindings: boolean;
  /** UI binds an entity list (data-grid, data-list, etc.) */
  hasEntityListBinding: boolean;
  /** Effects include agent/* operators */
  hasAgentEffects: boolean;
  /** Which agent operators are used */
  agentOperators: string[];
}

/**
 * Scan a transition's effects array for entity bindings in render-ui trees.
 *
 * Only inspects `['render-ui', slot, uiTree]` effects where uiTree is non-null.
 * Returns which kinds of entity bindings were found so callers can decide
 * which DOM checks are applicable without relying on pattern names or event names.
 */
export function scanEffectsForEntityBindings(effects: unknown[]): EntityBindingScan {
  let hasEntityFieldBindings = false;
  let hasEntityListBinding = false;
  let hasAgentEffects = false;
  const agentOperators: string[] = [];

  function scan(value: unknown): void {
    if (hasEntityFieldBindings && hasEntityListBinding) return;

    if (Array.isArray(value)) {
      // S-expression: ['object/get', ['array/first', '@entity'], 'field']
      if (
        value[0] === 'object/get' &&
        Array.isArray(value[1]) &&
        value[1][1] === '@entity'
      ) {
        hasEntityFieldBindings = true;
        return;
      }
      for (const item of value) scan(item);
    } else if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      for (const [key, val] of Object.entries(obj)) {
        if (key === 'entity' && typeof val === 'string') {
          hasEntityListBinding = true;
        }
        scan(val);
      }
    } else if (typeof value === 'string') {
      if (value.startsWith('@entity.') || value.startsWith('@item.')) {
        hasEntityFieldBindings = true;
      }
    }
  }

  for (const effect of effects) {
    if (!Array.isArray(effect)) continue;
    // Detect agent/* operators
    const op = effect[0];
    if (typeof op === 'string' && op.startsWith('agent/')) {
      hasAgentEffects = true;
      if (!agentOperators.includes(op)) agentOperators.push(op);
    }
    // Scan render-ui for entity bindings
    if (op !== 'render-ui' || effect[2] == null) continue;
    scan(effect[2]);
  }

  return { hasEntityFieldBindings, hasEntityListBinding, hasAgentEffects, agentOperators };
}

/**
 * Check if ANY transition in a list has an entity list binding in its render-ui effects.
 *
 * Used to determine whether a trait ever renders a list of entity rows,
 * which gates row-count checks after persist create/delete.
 */
export function hasAnyEntityListBinding(transitions: Array<{ effects: unknown[] }>): boolean {
  return transitions.some(
    (t) => scanEffectsForEntityBindings(t.effects).hasEntityListBinding
  );
}
