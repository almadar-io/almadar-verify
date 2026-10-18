/**
 * G-VERIFY-030: a verify sandbox that swaps in workspace builds must swap the
 * whole closure — a workspace @almadar/runtime next to the lockfile's older
 * @almadar/std fails the client bundle ("getOperatorRunsOn is not exported").
 */
import { it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, lstatSync, realpathSync, symlinkSync } from 'node:fs';
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
  pkg(join(mono, 'packages/almadar-fixturelib'), '@almadar/fixturelib', '1.0.0', {}, false);
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
    pkg(join(mono, 'packages/almadar-runtime'), '@almadar/runtime', '6.90.0', { '@almadar/fixturelib': '*' });
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

it('a swapped-in build gets the third-party dependencies it declares and the sandbox lacks, from the workspace', () => {
  const { root, mono, app } = fixture();
  try {
    pkg(join(mono, 'packages/almadar-core'), '@almadar/core', '10.103.0', { '@noble/hashes': '1.8.0', lodash: '^4' });
    pkg(join(mono, 'packages/almadar-core/node_modules/@noble/hashes'), '@noble/hashes', '1.8.0', {}, false);
    pkg(join(mono, 'node_modules/lodash'), 'lodash', '4.0.0', {}, false);
    pkg(join(app, 'node_modules/lodash'), 'lodash', '4.17.0', {}, false);
    overrideWithWorkspaceBuilds(app, mono, ['@almadar/core']);
    const noble = join(app, 'node_modules/@noble/hashes');
    expect(realpathSync(noble)).toBe(realpathSync(join(mono, 'packages/almadar-core/node_modules/@noble/hashes')));
    expect(lstatSync(join(app, 'node_modules/lodash')).isSymbolicLink()).toBe(false);
    expect(versionOf(join(app, 'node_modules/lodash'))).toBe('4.17.0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('a package pnpm linked into the sandbox from its store is swapped in the store copy, and the workspace is left alone', () => {
  const { root, mono, app } = fixture();
  try {
    const store = join(app, 'node_modules/.pnpm/@almadar+core@10.102.0/node_modules/@almadar/core');
    pkg(store, '@almadar/core', '10.102.0');
    rmSync(join(app, 'node_modules/@almadar/core'), { recursive: true, force: true });
    symlinkSync(store, join(app, 'node_modules/@almadar/core'), 'dir');
    overrideWithWorkspaceBuilds(app, mono, ['@almadar/core']);
    expect(versionOf(join(app, 'node_modules/@almadar/core'))).toBe('10.103.0');
    expect(readFileSync(join(store, 'dist/index.js'), 'utf-8')).toMatch(/10\.103\.0/);
    expect(lstatSync(join(app, 'node_modules/@almadar/core')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(app, 'node_modules/@almadar/core'))).not.toBe(realpathSync(join(mono, 'packages/almadar-core')));
    expect(versionOf(join(mono, 'packages/almadar-core'))).toBe('10.103.0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('every store copy of a closure member is swapped, including the ones another store package resolves its own dependency to', () => {
  const { root, mono, app } = fixture();
  try {
    const stores = join(app, 'node_modules/.pnpm');
    const own = join(stores, '@almadar+std@16.227.0/node_modules/@almadar/std');
    const older = join(stores, '@almadar+std@16.100.0/node_modules/@almadar/std');
    const nested = join(stores, '@almadar+runtime@6.89.0/node_modules/@almadar/std');
    pkg(own, '@almadar/std', '16.227.0');
    pkg(older, '@almadar/std', '16.100.0');
    mkdirSync(join(stores, '@almadar+runtime@6.89.0/node_modules/@almadar'), { recursive: true });
    symlinkSync(older, nested, 'dir');
    rmSync(join(app, 'node_modules/@almadar/std'), { recursive: true, force: true });
    symlinkSync(own, join(app, 'node_modules/@almadar/std'), 'dir');
    overrideWithWorkspaceBuilds(app, mono, ['@almadar/std']);
    expect(versionOf(own)).toBe('16.228.0');
    expect(versionOf(nested)).toBe('16.228.0');
    expect(readFileSync(join(nested, 'dist/index.js'), 'utf-8')).toMatch(/16\.228\.0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('control: a store copy of a package outside the closure is left as installed', () => {
  const { root, mono, app } = fixture();
  try {
    const other = join(app, 'node_modules/.pnpm/@almadar+fixturelib@0.9.0/node_modules/@almadar/fixturelib');
    pkg(other, '@almadar/fixturelib', '0.9.0');
    overrideWithWorkspaceBuilds(app, mono, ['@almadar/std']);
    expect(versionOf(other)).toBe('0.9.0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
