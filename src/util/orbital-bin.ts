/**
 * Resolve the `orbital`/`orb` compiler binary without depending on PATH.
 *
 * Verify tools run under shells that may not carry ~/bin (MCP servers,
 * CI steps), where spawning a bare `orbital` dies with "not found".
 * Resolution order mirrors the repo convention (`packages/almadar-tools`):
 * ORBITAL_BIN env → PATH lookup → ~/bin/orbital → workspace release build.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

let cached: string | null = null;

export function resolveOrbitalBin(): string {
  if (cached !== null) return cached;

  const fromEnv = process.env['ORBITAL_BIN'];
  if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) {
    cached = fromEnv;
    return cached;
  }

  try {
    const found = execFileSync('which', ['orbital'], { encoding: 'utf-8' }).trim();
    if (found !== '' && existsSync(found)) {
      cached = found;
      return cached;
    }
  } catch { /* not on PATH — fall through */ }

  const homeBin = join(homedir(), 'bin', 'orbital');
  if (existsSync(homeBin)) {
    cached = homeBin;
    return cached;
  }

  const workspaceBin = join(process.cwd(), 'orbital-rust', 'target', 'release', 'orbital');
  if (existsSync(workspaceBin)) {
    cached = workspaceBin;
    return cached;
  }

  throw new Error(
    'orbital binary not found. Set ORBITAL_BIN, add orbital to PATH, ' +
    `install to ${homeBin}, or build orbital-rust (make release install).`,
  );
}

/** Test hook: drop the memoized resolution. */
export function resetOrbitalBinCache(): void {
  cached = null;
}
