/**
 * The Node toolchain for processes verify tools spawn. A daemon (launchd/systemd) runs without the
 * user's PATH, so pnpm and node are resolved from declared places, in order: `PNPM_BIN`, the PATH,
 * then the Node installation running this process (where corepack installs `pnpm`).
 */
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

export interface ToolchainSource {
  env: NodeJS.ProcessEnv;
  /** The running node binary (`process.execPath`). */
  execPath: string;
}

const current = (): ToolchainSource => ({ env: process.env, execPath: process.execPath });

export function resolvePnpmBin(source: ToolchainSource = current()): string {
  const fromEnv = source.env['PNPM_BIN'];
  if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) return fromEnv;
  for (const dir of (source.env['PATH'] ?? '').split(delimiter)) {
    if (dir !== '' && existsSync(join(dir, 'pnpm'))) return join(dir, 'pnpm');
  }
  const besideNode = join(dirname(source.execPath), 'pnpm');
  if (existsSync(besideNode)) return besideNode;
  throw new Error(`pnpm not found: set PNPM_BIN, put pnpm on PATH, or install it beside ${source.execPath}`);
}

/** The environment for a spawned toolchain process: the running node's directory leads PATH. */
export function toolchainEnv(source: ToolchainSource = current()): NodeJS.ProcessEnv {
  const nodeDir = dirname(source.execPath);
  const path = source.env['PATH'];
  return { ...source.env, PATH: path !== undefined && path !== '' ? `${nodeDir}${delimiter}${path}` : nodeDir };
}
