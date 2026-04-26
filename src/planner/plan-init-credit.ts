/**
 * `planInitCredit` — produce just the synthetic auto-init step for a
 * trait, without running the full edge-covering walk.
 *
 * Useful when callers want to assemble a custom plan (e.g., emit-sweep
 * only) but still need the INIT credit for the coverage denominator.
 * `planWalk` already prepends this step by default; this is the
 * standalone variant for fine-grained composition.
 *
 * @packageDocumentation
 */

import type { ExtendedWalkStep } from './types.js';
import type { TraitWalkConfig } from '../engine/types.js';

export function planInitCredit(trait: TraitWalkConfig): ExtendedWalkStep {
  return {
    from: trait.initialState,
    event: 'INIT',
    to: trait.initialState,
    guardCase: null,
    payload: {},
    isRepositioning: false,
    traitName: trait.traitName,
    triggerKind: 'auto-init',
    coverageKey: `${trait.traitName}:${trait.initialState}+INIT->${trait.initialState}`,
  };
}
