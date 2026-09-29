/**
 * The registry walk names each behavior's import prefix: the `orb.prefix` its package declares
 * (`uses X from "<prefix>/<name>"`), so a behavior's address never has to be guessed from where it
 * sits on disk.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { walkRegistryBehaviors } from '../registry-discovery.js';

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
