/**
 * G-VERIFY-030: a verify sandbox that swaps in workspace builds must swap the
 * whole closure — a workspace @almadar/runtime next to the lockfile's older
 * @almadar/std fails the client bundle ("getOperatorRunsOn is not exported").
 */
import { it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { overrideWithWorkspaceBuilds, workspaceOverrideClosure } from '../workspace-overrides.js';

function pkg(dir: string, name: string, version: string, deps: Record<string, string> = {}, withDist = true): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, dependencies: deps }));
  if (withDist) {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'index.js'), `export const version = '${version}';`);
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ws-override-'));
  const mono = join(root, 'mono');
  pkg(join(mono, 'packages/almadar-runtime'), '@almadar/runtime', '6.90.0', { '@almadar/std': '^16.228.0', '@almadar/core': '*', lodash: '^4' });
  pkg(join(mono, 'packages/almadar-std'), '@almadar/std', '16.228.0', { '@almadar/core': '*' });
  pkg(join(mono, 'packages/almadar-core'), '@almadar/core', '10.103.0');
  pkg(join(mono, 'packages/almadar-llm'), '@almadar/llm', '1.0.0', {}, false);
  const app = join(root, 'app');
  pkg(join(app, 'node_modules/@almadar/runtime'), '@almadar/runtime', '6.89.0');
  pkg(join(app, 'node_modules/@almadar/std'), '@almadar/std', '16.227.0');
  pkg(join(app, 'node_modules/@almadar/core'), '@almadar/core', '10.102.0');
  return { root, mono, app };
}

const versionOf = (dir: string) => (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { version: string }).version;

it('the closure follows @almadar dependencies that have a workspace build', () => {
  const { root, mono } = fixture();
  try {
    expect(workspaceOverrideClosure(mono, ['@almadar/runtime']).sort()).toEqual(['@almadar/core', '@almadar/runtime', '@almadar/std']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('edge: a dependency with no workspace build is not part of the closure', () => {
  const { root, mono } = fixture();
  try {
    pkg(join(mono, 'packages/almadar-runtime'), '@almadar/runtime', '6.90.0', { '@almadar/llm': '*' });
    expect(workspaceOverrideClosure(mono, ['@almadar/runtime'])).toEqual(['@almadar/runtime']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('overriding runtime also swaps the std and core it depends on', () => {
  const { root, mono, app } = fixture();
  try {
    overrideWithWorkspaceBuilds(app, mono, ['@almadar/runtime']);
    expect(versionOf(join(app, 'node_modules/@almadar/runtime'))).toBe('6.90.0');
    expect(versionOf(join(app, 'node_modules/@almadar/std'))).toBe('16.228.0');
    expect(versionOf(join(app, 'node_modules/@almadar/core'))).toBe('10.103.0');
    expect(readFileSync(join(app, 'node_modules/@almadar/std/dist/index.js'), 'utf-8')).toMatch(/16\.228\.0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('a dependency of a swapped-in build that the app never installed is linked to the workspace package (its own deps resolve from the monorepo)', () => {
  const { root, mono, app } = fixture();
  try {
    rmSync(join(app, 'node_modules/@almadar/core'), { recursive: true, force: true });
    overrideWithWorkspaceBuilds(app, mono, ['@almadar/runtime']);
    const linked = join(app, 'node_modules/@almadar/core');
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(realpathSync(linked)).toBe(realpathSync(join(mono, 'packages/almadar-core')));
    expect(versionOf(linked)).toBe('10.103.0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('control: a root the app never installed, which no swapped build needs, is not added', () => {
  const { root, mono, app } = fixture();
  try {
    pkg(join(mono, 'packages/almadar-workspace'), '@almadar/workspace', '0.11.25');
    overrideWithWorkspaceBuilds(app, mono, ['@almadar/runtime', '@almadar/workspace']);
    expect(existsSync(join(app, 'node_modules/@almadar/workspace'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('re-running over a sandbox that already links a package never writes through the link into the workspace', () => {
  const { root, mono, app } = fixture();
  try {
    rmSync(join(app, 'node_modules/@almadar/core'), { recursive: true, force: true });
    overrideWithWorkspaceBuilds(app, mono, ['@almadar/runtime']);
    overrideWithWorkspaceBuilds(app, mono, ['@almadar/runtime', '@almadar/core']);
    expect(existsSync(join(mono, 'packages/almadar-core/dist/index.js'))).toBe(true);
    expect(lstatSync(join(app, 'node_modules/@almadar/core')).isSymbolicLink()).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
