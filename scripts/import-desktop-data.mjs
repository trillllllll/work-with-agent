import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要一个路径`);
  return value;
}
const defaultDataDir = process.platform === 'win32'
  ? resolve(process.env.LOCALAPPDATA || process.env.APPDATA || homedir(), 'dovun')
  : resolve(homedir(), 'Library', 'Application Support', 'dovun');
const source = resolve(flag('--source-dir', resolve(root, 'server/data')));
const target = resolve(flag('--data-dir', defaultDataDir));
const sourceEntry = resolve(root, 'server/src/desktop-migrate.ts');
const entry = existsSync(sourceEntry) ? sourceEntry : resolve(root, 'server/dist/desktop-migrate.js');
if (!existsSync(entry)) throw new Error('找不到数据迁移工具');
// Reuse the offline backup, full-folder verification and conflict rules from desktop startup.
const prefix = entry.endsWith('.ts') ? ['--import', resolve(root, 'node_modules/tsx/dist/loader.mjs')] : [];
execFileSync(process.execPath, [...prefix, entry, source, target], { stdio: 'inherit' });
