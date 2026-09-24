import type { EntityRow } from '@almadar/core';
import { pickTargetRow } from '../../planner/internal/self-relation-fields.js';

/** Fill each declared `:param` with a real row id of the entity it names; an undeclared or rowless param stays literal so the walk fails honestly. */
export async function fillRouteParams(
  route: string | undefined,
  paramEntities: Readonly<Record<string, string>> | undefined,
  listRows: ((entity: string) => Promise<ReadonlyArray<EntityRow>>) | undefined,
): Promise<string | undefined> {
  if (route === undefined || paramEntities === undefined || listRows === undefined) return route;
  const segments = route.split('/');
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined || !segment.startsWith(':')) continue;
    const entity = paramEntities[segment.slice(1)];
    if (entity === undefined) continue;
    const rows = await listRows(entity);
    const pick = pickTargetRow(rows, rows, undefined);
    if ('row' in pick && pick.row.id !== undefined && pick.row.id !== null) {
      segments[i] = encodeURIComponent(String(pick.row.id));
    }
  }
  return segments.join('/');
}
