/**
 * Behavior-registry discovery — a structure-agnostic walk of the std + io
 * registries, shared by any tool or service that needs the full catalog of
 * `.orb` behaviors (a catalog UI, a build-time resolve pass, a coverage map).
 *
 * Moved here from `tools/runtime-verify/src/catalog-parser.ts` (2026-09-15):
 * that package already depends on `@almadar-io/playground-runtime`, so a
 * second consumer (`playground-runtime` itself, building a production
 * catalog) importing back from `tools/runtime-verify` would be a circular
 * package dependency. `@almadar-io/verify` is the crate both already share.
 *
 * Unlike the original call site (which guessed the repo root via
 * `import.meta.dirname` + a fixed `../..` hop count — only valid because it
 * ran from one specific file's fixed depth inside a live monorepo checkout),
 * this shared version requires the root explicitly: this package is
 * installed into many other packages' `node_modules` at very different
 * depths, so a directory-depth guess here would silently return an empty
 * catalog instead of erroring. Callers that want the old convenience
 * fallback keep computing it themselves and pass the result in.
 */

import { resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

export type RegistryTierLevel = 'atom' | 'molecule' | 'organism' | 'template';

/**
 * Canonical tier-dir → behavior level. The four tier dir names are the ONLY
 * structural assumption the registry walk makes: a `.orb` is a behavior iff
 * its parent directory is one of these. Everything above the tier dir is the
 * topic.
 */
export const TIER_LEVELS: Readonly<Record<string, RegistryTierLevel>> = {
  atoms: 'atom',
  molecules: 'molecule',
  organisms: 'organism',
  templates: 'template',
};

export interface DiscoveredBehavior {
  /** Behavior name (file basename, no `.orb`). */
  name: string;
  /** Absolute path to the raw registry `.orb`. */
  orbPath: string;
  /** Topic = dir path relative to `behaviors/registry`, minus the trailing tier
   *  segment, `/`-joined (e.g. `core`, `core-variations`, `ui/game/2d`). */
  topic: string;
  /** The trailing tier-dir name (`atoms` | `molecules` | `organisms` | `templates`). */
  tier: string;
  /** Behavior level derived from the tier dir. */
  level: RegistryTierLevel;
}

/**
 * Fully structure-agnostic registry walk. Recursively descends a registry root
 * (`behaviors/registry`) and yields every `.orb` whose PARENT directory is a
 * tier dir (atoms/molecules/organisms/templates) — no hardcoded topic list, no
 * fixed nesting depth. `topic` is derived from the path (everything above the
 * tier dir), so `core/atoms/x.orb` → topic `core`, `ui/game/2d/atoms/x.orb` →
 * topic `ui/game/2d`. New topics or deeper nesting are picked up automatically.
 */
export function* walkRegistryBehaviors(registryBase: string): Generator<DiscoveredBehavior> {
  // `rel` is the current dir's path relative to the registry root, `/`-joined.
  function* descend(dir: string, rel: string): Generator<DiscoveredBehavior> {
    const dirName = rel === '' ? '' : (rel.split('/').pop() ?? '');
    const level = TIER_LEVELS[dirName];
    if (level) {
      // This dir IS a tier dir: its `.orb` files are behaviors whose topic is
      // the parent path (rel minus the trailing tier segment).
      const topic = rel.split('/').slice(0, -1).join('/');
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.orb')) {
          yield {
            name: entry.name.replace(/\.orb$/, ''),
            orbPath: resolve(dir, entry.name),
            topic,
            tier: dirName,
            level,
          };
        }
      }
      return; // tier dirs hold only behaviors — no nested topics below them
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        yield* descend(resolve(dir, entry.name), rel === '' ? entry.name : `${rel}/${entry.name}`);
      }
    }
  }
  yield* descend(registryBase, '');
}

/**
 * Resolve the std + behaviors registry roots that actually exist on disk.
 * Requires the monorepo root explicitly (`root` argument or `ALMADAR_ROOT`
 * env) — no directory-depth guessing, see the module doc comment.
 */
export function registryBases(root?: string): string[] {
  const repoRoot = root ?? process.env['ALMADAR_ROOT'];
  if (!repoRoot) {
    throw new Error(
      'registryBases() requires the monorepo root — pass it explicitly or set ALMADAR_ROOT. ' +
        'This shared implementation does not guess a path from the calling file’s location.',
    );
  }
  return [
    resolve(repoRoot, 'packages/almadar-std/behaviors/registry'),
    resolve(repoRoot, 'packages/almadar-behaviors/behaviors/registry'),
  ].filter((b) => existsSync(b));
}

/** Discovered behaviors across both registries (std first → wins collisions). */
export function discoverAllBehaviors(root?: string): DiscoveredBehavior[] {
  const out: DiscoveredBehavior[] = [];
  const seen = new Set<string>();
  for (const registryBase of registryBases(root)) {
    for (const b of walkRegistryBehaviors(registryBase)) {
      if (seen.has(b.name)) continue;
      seen.add(b.name);
      out.push(b);
    }
  }
  return out;
}
