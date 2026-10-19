/**
 * The row context a replay hop takes from the walk's crud step for the same transition: that step's entity, bound
 * from server truth, and its row shape (G-ORBITAL-SHELL-TYPESCRIPT-026). A hop that binds its own row, or a transition
 * no crud step with a row shape covers, takes nothing.
 *
 * @packageDocumentation
 */
import type { ExtendedWalkStep } from '../planner/types.js';

export function replayRowContext(
  hop: ExtendedWalkStep,
  plan: readonly ExtendedWalkStep[],
): Pick<ExtendedWalkStep, 'bindRowFrom' | 'payloadRowShape'> {
  if (hop.bindRowFrom !== undefined) return {};
  const crud = plan.find((s) =>
    (s.testKind === 'crud-edit' || s.testKind === 'crud-delete')
    && s.from === hop.from && s.event === hop.event && s.to === hop.to
    && s.payloadRowShape !== undefined && s.payloadRowShape.length > 0 && s.expectedRowDelta !== undefined);
  if (crud?.payloadRowShape === undefined || crud.expectedRowDelta === undefined) return {};
  return {
    bindRowFrom: { entityName: crud.expectedRowDelta.entityName, payloadField: 'id', wholeRow: false },
    payloadRowShape: crud.payloadRowShape,
  };
}
