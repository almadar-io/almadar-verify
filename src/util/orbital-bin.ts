/**
 * The `orb` compiler binary the verify tools spawn, through `@almadar/core`'s one resolver (G-CROSS-261):
 * `ORB_BIN`, `ORBITAL_BIN`, `~/bin/orb`, the installed `@almadar/orb`, then `PATH`.
 */

import { resolveOrbBinary } from '@almadar/core/behavior-package';

export function resolveOrbitalBin(): string {
  return resolveOrbBinary();
}
