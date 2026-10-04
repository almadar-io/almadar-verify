/**
 * Verify tools spawn pnpm (and, through it, node scripts) from shells that may not carry the user's
 * PATH — the MCP daemon runs under launchd/systemd. The toolchain is resolved from declared places:
 * PNPM_BIN, then PATH, then the Node installation running this process.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolvePnpmBin, toolchainEnv } from '../node-toolchain.js';

function fakeBin(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\n');
  chmodSync(p, 0o755);
  return p;
}

describe('resolvePnpmBin', () => {
  it('PNPM_BIN wins when it exists', () => {
    const bin = fakeBin(mkdtempSync(join(tmpdir(), 'pnpm-env-')), 'pnpm');
    expect(resolvePnpmBin({ env: { PNPM_BIN: bin, PATH: '' }, execPath: '/nowhere/node' })).toBe(bin);
  });

  it('then the first pnpm on PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pnpm-path-'));
    const bin = fakeBin(dir, 'pnpm');
    expect(resolvePnpmBin({ env: { PATH: ['/nope', dir].join(delimiter) }, execPath: '/nowhere/node' })).toBe(bin);
  });

  it('edge: with no PATH (a daemon), the pnpm beside the running node', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pnpm-node-'));
    const bin = fakeBin(dir, 'pnpm');
    expect(resolvePnpmBin({ env: {}, execPath: join(dir, 'node') })).toBe(bin);
  });

  it('control: a PNPM_BIN that does not exist is not used', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pnpm-node-'));
    const bin = fakeBin(dir, 'pnpm');
    expect(resolvePnpmBin({ env: { PNPM_BIN: '/missing/pnpm' }, execPath: join(dir, 'node') })).toBe(bin);
  });

  it('edge: nowhere to be found is an error naming where it looked', () => {
    expect(() => resolvePnpmBin({ env: { PATH: '/nope' }, execPath: '/nowhere/node' })).toThrow(/PNPM_BIN.*PATH.*\/nowhere/);
  });
});

describe('toolchainEnv', () => {
  it('puts the running node\'s directory first on PATH, so scripts pnpm runs find the same node', () => {
    const env = toolchainEnv({ env: { PATH: '/usr/bin', HOME: '/h' }, execPath: '/opt/node/bin/node' });
    expect(env.PATH).toBe(['/opt/node/bin', '/usr/bin'].join(delimiter));
    expect(env.HOME).toBe('/h');
  });

  it('edge: with no PATH at all, PATH is just the node directory', () => {
    expect(toolchainEnv({ env: {}, execPath: '/opt/node/bin/node' }).PATH).toBe(dirname('/opt/node/bin/node'));
  });
});
