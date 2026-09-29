import { homedir } from 'node:os';
import { join } from 'node:path';

export const DESKTOP_PORT = 47316;

export function isDesktopPackage() {
  return process.env.WWA_PACKAGED === '1';
}

/** Shared with the Tauri shell. A custom WWA_DATA_DIR is for tests and smoke runs. */
export function desktopDataDir() {
  if (process.env.WWA_DATA_DIR) return process.env.WWA_DATA_DIR;
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || process.env.APPDATA || homedir(), 'work-with-agent');
  }
  return join(homedir(), 'Library', 'Application Support', 'work-with-agent');
}

export function desktopMcpCommand() {
  return join(desktopDataDir(), 'bin', 'wwa-mcp');
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
