/**
 * Swap a verify sandbox's npm-installed @almadar packages for the local
 * workspace builds. The swap covers the whole closure: a workspace package is
 * paired with workspace builds of the @almadar packages it depends on, never
 * with the older copies the generated lockfile pinned (a workspace runtime
 * next to the lockfile's std fails the client bundle on a new export).
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The packages a sandbox always verifies against their workspace builds. */
export const WORKSPACE_OVERRIDE_ROOTS: readonly string[] = [
  '@almadar/ui',
  '@almadar/integrations',
  '@almadar/server',
  '@almadar/server-hono',
  '@almadar/runtime',
];

interface Manifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** `@almadar/std` → `<monorepo>/packages/almadar-std`. */
function workspaceDir(monorepoRoot: string, name: string): string {
  return join(monorepoRoot, 'packages', `almadar-${name.slice('@almadar/'.length)}`);
}

function hasWorkspaceBuild(monorepoRoot: string, name: string): boolean {
  const dir = workspaceDir(monorepoRoot, name);
  return existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'dist'));
}

/** `roots` plus every @almadar package they depend on (transitively) that has a workspace build. */
export function workspaceOverrideClosure(monorepoRoot: string, roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = roots.filter((name) => hasWorkspaceBuild(monorepoRoot, name));
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const manifest = JSON.parse(readFileSync(join(workspaceDir(monorepoRoot, name), 'package.json'), 'utf-8')) as Manifest;
    for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      if (dep.startsWith('@almadar/') && !seen.has(dep) && hasWorkspaceBuild(monorepoRoot, dep)) queue.push(dep);
    }
  }
  return [...seen];
}

/**
 * Replace each installed closure member's `dist` + `package.json` with the
 * workspace build. A member the sandbox never installed is linked in (a
 * symlink to the workspace package, whose own dependencies resolve from the
 * monorepo) only when a swapped-in build depends on it; otherwise it is left
 * out. Returns the names it swapped or linked.
 */
export function overrideWithWorkspaceBuilds(
  outputDir: string,
  monorepoRoot: string,
  roots: readonly string[] = WORKSPACE_OVERRIDE_ROOTS,
): string[] {
  const swapped: string[] = [];
  for (const name of workspaceOverrideClosure(monorepoRoot, roots)) {
    const installed = join(outputDir, 'node_modules', ...name.split('/'));
    if (!existsSync(join(installed, 'dist'))) continue;
    // A link from an earlier run already IS the workspace package: never write through it.
    if (lstatSync(installed).isSymbolicLink()) {
      swapped.push(name);
      continue;
    }
    const local = workspaceDir(monorepoRoot, name);
    rmSync(join(installed, 'dist'), { recursive: true, force: true });
    cpSync(join(local, 'dist'), join(installed, 'dist'), { recursive: true });
    for (const file of ['package.json', 'tailwind-preset.cjs']) {
      if (existsSync(join(local, file))) cpSync(join(local, file), join(installed, file));
    }
    swapped.push(name);
  }
  for (const name of workspaceOverrideClosure(monorepoRoot, swapped)) {
    const installed = join(outputDir, 'node_modules', ...name.split('/'));
    if (swapped.includes(name) || existsSync(installed)) continue;
    mkdirSync(dirname(installed), { recursive: true });
    symlinkSync(workspaceDir(monorepoRoot, name), installed, 'dir');
    swapped.push(name);
  }
  return swapped;
}
