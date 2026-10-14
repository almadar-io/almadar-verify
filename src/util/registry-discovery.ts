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

import { relative, resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

import { behaviorRegistryDir, discoverBehaviorPackages, type BehaviorPackage } from '@almadar/core/behavior-package';

export type RegistryTierLevel = 'atom' | 'molecule' | 'organism' | 'template';

/**
 * Canonical tier-dir → behavior level. The four tier dir names are the ONLY
 * structural assumption the registry walk makes: a `.orb` is a behavior iff
 * it sits at or below one of these. Everything above the tier dir is the
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
  /** The import prefix its package declares (`orb.prefix`): `uses X from "<prefix>/<name>"`. */
  prefix: string;
  /** The behavior's `.lolo` under the package's declared `orb.source`, when that file exists. */
  sourcePath?: string;
}

/**
 * Fully structure-agnostic walk of a package's lowered tree. Recursively descends it
 * and yields every `.orb` whose PARENT directory is a
 * tier dir (atoms/molecules/organisms/templates) — no hardcoded topic list, no
 * fixed nesting depth. `topic` is derived from the path (everything above the
 * tier dir), so `core/atoms/x.orb` → topic `core`, `ui/game/2d/atoms/x.orb` →
 * topic `ui/game/2d`. New topics or deeper nesting are picked up automatically.
 */
export function* walkRegistryBehaviors(registry: BehaviorRegistry): Generator<DiscoveredBehavior> {
  const registryBase = registry.dir;
  const prefix = registry.pkg.orb.prefix;
  const sourceRoot = registry.pkg.orb.source === undefined ? null : resolve(registry.pkg.root, registry.pkg.orb.source);
  const sourcePathOf = (orbPath: string): string | null => {
    if (sourceRoot === null) return null;
    const lolo = resolve(sourceRoot, relative(registryBase, orbPath)).replace(/\.orb$/, '.lolo');
    return existsSync(lolo) ? lolo : null;
  };
  // `rel` is the current dir's path relative to the registry root, `/`-joined.
  function* descend(dir: string, rel: string): Generator<DiscoveredBehavior> {
    const dirName = rel === '' ? '' : (rel.split('/').pop() ?? '');
    const level = TIER_LEVELS[dirName];
    if (level) {
      // This dir IS a tier dir: its `.orb` files are behaviors whose topic is
      // the parent path (rel minus the trailing tier segment).
      const topic = rel.split('/').slice(0, -1).join('/');
      yield* behaviorsIn(dir, topic, dirName, level);
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        yield* descend(resolve(dir, entry.name), rel === '' ? entry.name : `${rel}/${entry.name}`);
      }
    }
  }
  // Below a tier dir every folder only groups behaviors (a site's blog posts):
  // they keep the tier dir's topic and level.
  function* behaviorsIn(dir: string, topic: string, tier: string, level: RegistryTierLevel): Generator<DiscoveredBehavior> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        yield* behaviorsIn(resolve(dir, entry.name), topic, tier, level);
      } else if (entry.isFile() && entry.name.endsWith('.orb')) {
        const orbPath = resolve(dir, entry.name);
        const sourcePath = sourcePathOf(orbPath);
        yield {
          name: entry.name.replace(/\.orb$/, ''),
          orbPath,
          topic,
          tier,
          level,
          prefix,
          ...(sourcePath !== null ? { sourcePath } : {}),
        };
      }
    }
  }
  yield* descend(registryBase, '');
}

/** An installed behavior package and its tree of lowered `.orb` programs. */
export interface BehaviorRegistry {
  pkg: BehaviorPackage;
  dir: string;
}

/**
 * Every behavior package installed under the monorepo root (std, io, vendor,
 * community — discovered by the same rule `orb` uses), each with its lowered
 * `.orb` tree. Requires the root explicitly (`root` argument or `ALMADAR_ROOT`
 * env) — no directory-depth guessing, see the module doc comment.
 */
export function behaviorRegistries(root?: string, userStore?: string): BehaviorRegistry[] {
  const repoRoot = root ?? process.env['ALMADAR_ROOT'];
  if (!repoRoot) {
    throw new Error(
      'behaviorRegistries() requires the monorepo root — pass it explicitly or set ALMADAR_ROOT. ' +
        'This shared implementation does not guess a path from the calling file’s location.',
    );
  }
  return discoverBehaviorPackages(repoRoot, userStore).map((pkg) => ({ pkg, dir: behaviorRegistryDir(pkg) }));
}

/** The registry roots of {@link behaviorRegistries}. */
export function registryBases(root?: string): string[] {
  return behaviorRegistries(root).map((r) => r.dir);
}

/**
 * Every behavior across every installed package. Behaviors are keyed by bare
 * name downstream, so a name two packages both ship fails, naming them,
 * instead of one silently winning.
 */
export function discoverAllBehaviors(root?: string, userStore?: string): DiscoveredBehavior[] {
  const out: DiscoveredBehavior[] = [];
  const owner = new Map<string, string>();
  for (const registry of behaviorRegistries(root, userStore)) {
    for (const b of walkRegistryBehaviors(registry)) {
      const other = owner.get(b.name);
      if (other !== undefined) {
        throw new Error(`behavior ${b.name} is shipped by both ${other} and ${registry.pkg.name} — address it by prefix`);
      }
      owner.set(b.name, registry.pkg.name);
      out.push(b);
    }
  }
  return out;
}
