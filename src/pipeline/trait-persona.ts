/**
 * The persona a trait's walk signs in as when a role policy gates its steps: the first roster persona holding the one
 * role every role-gated step of the plan requires (G-ORBITAL-SHELL-TYPESCRIPT-026). Steps that need different roles,
 * owner-only requirements and a role no roster persona holds leave the app's default persona; each step then
 * switches for itself.
 *
 * @packageDocumentation
 */
import type { RawUserClaims } from '@almadar/core';
import type { ExtendedWalkStep } from '../planner/types.js';

export function traitPersona(plan: readonly ExtendedWalkStep[], roster: readonly RawUserClaims[]): RawUserClaims | undefined {
  const roles = plan.flatMap((s) => [s.viewerRequirement?.role, s.establishesRow?.viewerRequirement?.role]).filter((r) => r !== undefined);
  const [first] = roles;
  if (first === undefined || roles.some((r) => r.field !== first.field || r.value !== first.value)) return undefined;
  return roster.find((persona) => persona[first.field] === first.value);
}
