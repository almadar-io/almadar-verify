/**
 * `value-leaves` — the JS twin of orbital-core's `SExpression::value_leaves`:
 * which leaf values an expression can yield, read from the operator registry's
 * declared `returnSemantics` (documented once, in `@almadar/std` `types.ts`).
 * One generic interpreter; no operator is named here.
 *
 * - `identity-of-arg<N>`  → the leaves of argument N;
 * - `branch-union`        → every argument after the condition;
 * - `union-of-args`       → every argument; `union-of-args<i,j>` the listed ones;
 * - `last-of-args`        → the last argument;
 * - `lambda-result`       → the body of the lambda argument (the argument whose
 *                           operator declares `returnType: 'function'`);
 * - anything else, including an operator with no declaration → OPAQUE: the
 *   expression itself, crediting nothing beyond what it literally is.
 *
 * Arity is the validator's concern: a declared kind naming an absent argument
 * makes the call opaque.
 *
 * @packageDocumentation
 */

import { getStdOperatorMeta } from '@almadar/std/registry';

/** Any IR value the walk inspects; only arrays are structurally examined. */
export type ValueNode = string | number | boolean | null | undefined | object;

/** The registry facts the walk reads. */
export interface OperatorReturn {
  readonly returnSemantics?: string;
  readonly returnType: string;
}

export type OperatorLookup = (operator: string) => OperatorReturn | undefined;

export const stdOperatorLookup: OperatorLookup = getStdOperatorMeta;

type Slot = { readonly kind: 'arg'; readonly index: number } | { readonly kind: 'lambda-body'; readonly index: number };

const argSlot = (index: number): Slot => ({ kind: 'arg', index });

function planSources(
  lookup: OperatorLookup,
  operator: string,
  args: readonly ValueNode[],
): Slot[] | undefined {
  const sem = lookup(operator)?.returnSemantics;
  if (sem === undefined) return undefined;
  const count = args.length;
  let slots: Slot[];
  switch (sem) {
    case 'branch-union':
      if (count < 2) return undefined;
      return args.slice(1).map((_, i) => argSlot(i + 1));
    case 'union-of-args':
      slots = args.map((_, i) => argSlot(i));
      break;
    case 'last-of-args':
      slots = count > 0 ? [argSlot(count - 1)] : [];
      break;
    case 'lambda-result': {
      let found: Slot[] = [];
      for (let i = count - 1; i >= 0; i--) {
        if (lambdaBody(args[i], lookup) !== undefined) {
          found = [{ kind: 'lambda-body', index: i }];
          break;
        }
      }
      slots = found;
      break;
    }
    default: {
      const match = /^(?:identity-of-arg|union-of-args)<(\d+(?:,\s*\d+)*)>$/.exec(sem);
      if (match === null) return undefined;
      const indices = match[1].split(',').map((n) => Number.parseInt(n.trim(), 10));
      if (indices.some((i) => i >= count)) return undefined;
      slots = indices.map(argSlot);
    }
  }
  return slots.length > 0 ? slots : undefined;
}

/** The body of a `[lambda-op, params, body]` call whose operator declares `returnType: 'function'`. */
function lambdaBody(node: ValueNode, lookup: OperatorLookup): ValueNode | undefined {
  if (!Array.isArray(node) || node.length < 3 || typeof node[0] !== 'string') return undefined;
  return lookup(node[0])?.returnType === 'function' ? node[node.length - 1] : undefined;
}

/** Every possible value source of `value`, resolved through the registry's declared `returnSemantics`. */
export function valueLeaves(value: ValueNode, lookup: OperatorLookup = stdOperatorLookup): ValueNode[] {
  if (!Array.isArray(value) || typeof value[0] !== 'string') return [value];
  const args: ValueNode[] = value.slice(1);
  const slots = planSources(lookup, value[0], args);
  if (slots === undefined) return [value];
  const out: ValueNode[] = [];
  for (const slot of slots) {
    const source = slot.kind === 'arg' ? args[slot.index] : lambdaBody(args[slot.index], lookup);
    if (source !== undefined) out.push(...valueLeaves(source, lookup));
  }
  return out;
}
