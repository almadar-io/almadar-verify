/**
 * The registry walk names each behavior's import prefix: the `orb.prefix` its package declares
 * (`uses X from "<prefix>/<name>"`), so a behavior's address never has to be guessed from where it
 * sits on disk.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { behaviorRegistries, discoverAllBehaviors, walkRegistryBehaviors } from '../registry-discovery.js';

function registry(withPackage: object | null): string {
  const root = mkdtempSync(path.join(tmpdir(), 'registry-walk-'));
  const atoms = path.join(root, 'behaviors', 'registry', 'core', 'atoms');
  mkdirSync(atoms, { recursive: true });
  writeFileSync(path.join(atoms, 'x-list.orb'), '{}');
  if (withPackage !== null) writeFileSync(path.join(root, 'package.json'), JSON.stringify(withPackage));
  return path.join(root, 'behaviors', 'registry');
}

describe('walkRegistryBehaviors', () => {
  it('names each behavior\'s import prefix from its package\'s orb block', () => {
    const [b] = [...walkRegistryBehaviors(registry({ name: '@acme/behaviors', orb: { prefix: 'acme', registry: 'behaviors/registry' } }))];
    expect(b).toMatchObject({ name: 'x-list', topic: 'core', level: 'atom', prefix: 'acme' });
  });

  it('control: a registry whose package declares no orb block, or has no package, names no prefix', () => {
    for (const base of [registry({ name: 'plain' }), registry(null)]) {
      const [b] = [...walkRegistryBehaviors(base)];
      expect(b?.name).toBe('x-list');
      expect(b && 'prefix' in b).toBe(false);
    }
  });

  it('edge: a package whose orb registry is elsewhere is not this registry\'s package', () => {
    const [b] = [...walkRegistryBehaviors(registry({ name: '@acme/behaviors', orb: { prefix: 'acme', registry: 'other/registry' } }))];
    expect(b && 'prefix' in b).toBe(false);
  });
});

describe('walkRegistryBehaviors — grouping folders under a tier', () => {
  function grouped(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'registry-group-'));
    const atoms = path.join(root, 'websites', 'atoms');
    mkdirSync(path.join(atoms, 'almadar-blog', 'deeper'), { recursive: true });
    writeFileSync(path.join(atoms, 'site-home.orb'), '{}');
    writeFileSync(path.join(atoms, 'almadar-blog', 'post-a-en.orb'), '{}');
    writeFileSync(path.join(atoms, 'almadar-blog', 'post-a-en.ar.json'), '{}');
    writeFileSync(path.join(atoms, 'almadar-blog', 'deeper', 'post-b-en.orb'), '{}');
    return root;
  }

  it('a behavior in a folder under a tier dir keeps that tier and topic', () => {
    const found = [...walkRegistryBehaviors(grouped())];
    expect(found.find((b) => b.name === 'post-a-en')).toMatchObject({ topic: 'websites', tier: 'atoms', level: 'atom' });
  });

  it('control: a behavior directly in the tier dir is still found', () => {
    const found = [...walkRegistryBehaviors(grouped())];
    expect(found.find((b) => b.name === 'site-home')).toMatchObject({ topic: 'websites', tier: 'atoms' });
  });

  it('edge: nested grouping folders are walked too, and non-.orb files are not behaviors', () => {
    const names = [...walkRegistryBehaviors(grouped())].map((b) => b.name).sort();
    expect(names).toEqual(['post-a-en', 'post-b-en', 'site-home']);
  });
});


describe('behaviorRegistries — every installed behavior package', () => {
  function installed(packages: Record<string, { prefix: string; orbs: string[] }>): string {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'registry-installed-')));
    for (const [name, { prefix, orbs }] of Object.entries(packages)) {
      const dir = path.join(root, 'node_modules', name);
      mkdirSync(path.join(dir, 'registry'), { recursive: true });
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', orb: { prefix, registry: 'registry', index: 'i.json', factorySignatures: 'f.json', loloContracts: 'c.json', signatures: 's.lolo', embeddings: [], compiler: '>=1.0.0' } }),
      );
      for (const rel of orbs) {
        mkdirSync(path.join(dir, 'registry', rel, '..'), { recursive: true });
        writeFileSync(path.join(dir, 'registry', rel), '{}');
      }
    }
    return root;
  }

  it('walks a vendor package beside std, each behavior carrying its package prefix', () => {
    const root = installed({
      '@almadar/std': { prefix: 'std/behaviors', orbs: ['ui/core/atoms/std-list.orb'] },
      '@acme/hr-behaviors': { prefix: 'acme-hr', orbs: ['app/organisms/acme-payroll.orb'] },
    });
    expect(behaviorRegistries(root).map((r) => r.pkg.name)).toEqual(['@acme/hr-behaviors', '@almadar/std']);
    expect(discoverAllBehaviors(root).map((b) => `${b.prefix}/${b.name}`)).toEqual(['acme-hr/acme-payroll', 'std/behaviors/std-list']);
  });

  it('a bare name two packages ship fails naming both', () => {
    const root = installed({
      '@acme/hr-behaviors': { prefix: 'acme-hr', orbs: ['app/organisms/payroll.orb'] },
      '@community/payroll': { prefix: 'community-payroll', orbs: ['app/organisms/payroll.orb'] },
    });
    expect(() => discoverAllBehaviors(root)).toThrow(/payroll is shipped by both @acme\/hr-behaviors and @community\/payroll/);
  });

  it('control: a root with no behavior packages discovers nothing', () => {
    expect(discoverAllBehaviors(installed({}))).toEqual([]);
  });
});

describe('walkRegistryBehaviors — sourcePath from the package manifest', () => {
  it('names the .lolo under the declared orb.source, wherever the lowered tree lives', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'registry-source-')));
    const pkgRoot = path.join(root, 'pkg');
    mkdirSync(path.join(pkgRoot, 'behaviors/lolo/app/atoms'), { recursive: true });
    writeFileSync(path.join(pkgRoot, 'behaviors/lolo/app/atoms/x-list.lolo'), 'app x-list');
    writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: '@acme/b', version: '1.0.0', orb: { prefix: 'acme', source: 'behaviors/lolo', index: 'i', factorySignatures: 'f', loloContracts: 'c', signatures: 's', embeddings: [], compiler: '>=1.0.0' } }));
    const mirror = path.join(root, 'derived', 'registry', 'abc123');
    mkdirSync(path.join(mirror, 'app/atoms'), { recursive: true });
    writeFileSync(path.join(mirror, 'app/atoms/x-list.orb'), '{}');
    writeFileSync(path.join(mirror, 'app/atoms/orphan.orb'), '{}');
    const pkg = { name: '@acme/b', version: '1.0.0', root: pkgRoot, lock: null, orb: { prefix: 'acme', source: 'behaviors/lolo', index: 'i', factorySignatures: 'f', loloContracts: 'c', signatures: 's', embeddings: [], compiler: '>=1.0.0' } };
    const found = [...walkRegistryBehaviors({ pkg, dir: mirror })];
    expect(found.find((b) => b.name === 'x-list')?.sourcePath).toBe(path.join(pkgRoot, 'behaviors/lolo/app/atoms/x-list.lolo'));
    expect(found.find((b) => b.name === 'orphan') && 'sourcePath' in found.find((b) => b.name === 'orphan')!).toBe(false);
  });

  it('control: a bare registry path (no package) carries no sourcePath', () => {
    const [b] = [...walkRegistryBehaviors(registry(null))];
    expect(b && 'sourcePath' in b).toBe(false);
  });
});
