import { runtimeEnv } from '../shared/runtime-env.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DESKTOP_PORT = 47317;

export function isDesktopPackage() {
  return runtimeEnv('PACKAGED') === '1';
}

/** Server mode exposes the workspace over the network for multi-device access instead of staying loopback-only. */
export function isServerMode() {
  return (runtimeEnv('SERVER_MODE') ?? (process.env.DOVUN_CONTAINER === '1' ? '1' : '0')) === '1';
}

/** The address remote clients use to reach this workspace, e.g. https://wwa.example.com. */
export function publicWorkspaceUrl() {
  return runtimeEnv('PUBLIC_URL')?.replace(/\/+$/, '') || '';
}

/** Shared with the Tauri shell. A custom DOVUN_DATA_DIR is for tests and smoke runs. */
export function desktopDataDir() {
  const override = runtimeEnv('DATA_DIR');
  if (override) return override;
  if (process.env.DOVUN_CONTAINER === '1') return '/data';
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || process.env.APPDATA || homedir(), 'dovun');
  }
  return join(homedir(), 'Library', 'Application Support', 'dovun');
}

export function desktopMcpCommand() {
  return join(desktopDataDir(), 'bin', 'dovun-mcp');
}

export function desktopMcpConfiguration(entry: string) {
  if (process.platform === 'win32' && isDesktopPackage()) {
    return { command: process.execPath, args: [entry] };
  }
  return { command: desktopMcpCommand(), args: [] as string[] };
}

/** Absolute SQLite URL. Spaces stay literal because the value is passed through the environment, not a shell. */
export function sqliteDatabaseUrl(filePath: string) {
  return `file:${filePath}`;
}
