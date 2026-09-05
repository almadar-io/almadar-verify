/**
 * declaredEntityRow — build an `@entity` row seeded with the entity's
 * DECLARED field defaults (`collectDeclaredEntityDefaults`, the one
 * `@almadar/runtime` owner), with explicit `overrides` spread on top so
 * caller bindings win. Mirrors the real runtime's own precedence
 * (`OrbitalServerRuntime` seeds declared defaults before persistence data
 * / `set` effects land on top) for in-process single-step players like
 * `playCircuitStep` and the `play_transition` MCP probe, which otherwise
 * hand guards an empty row and let `undefined` fields silently pass
 * `!=`-style guards.
 */
import type { Entity, EntityRef, EntityRow, OrbitalSchema } from '@almadar/core';
import { isEntityCall, isEntityReference } from '@almadar/core';
import { collectDeclaredEntityDefaults } from '@almadar/runtime';

function findInlineEntity(orbital: OrbitalSchema, name: string): Entity | undefined {
  for (const orb of orbital.orbitals) {
    const refs: EntityRef[] = [orb.entity, ...(orb.auxiliaryEntities ?? [])];
    for (const ref of refs) {
      if (isEntityReference(ref) || isEntityCall(ref)) continue; // string ref / EntityCall — resolved upstream by the inline phase
      if (ref.name === name) return ref;
    }
  }
  return undefined;
}

/**
 * Find `linkedEntity` by name in `orbital`'s inline entities and seed its
 * declared field defaults; `overrides` (typically the caller-supplied
 * `entity` bindings) win over any default with the same key. No
 * `linkedEntity` or no matching inline entity yields `overrides` alone.
 */
export function declaredEntityRow(
  orbital: OrbitalSchema,
  linkedEntity: string | undefined,
  overrides?: EntityRow,
): EntityRow {
  const entity = linkedEntity === undefined ? undefined : findInlineEntity(orbital, linkedEntity);
  return { ...(collectDeclaredEntityDefaults(entity) ?? {}), ...(overrides ?? {}) };
}
