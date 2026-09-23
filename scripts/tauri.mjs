import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const cli = resolve(root, 'node_modules/.bin/tauri');
const child = spawn(cli, process.argv.slice(2), {
  cwd: resolve(root, 'desktop/src-tauri'),
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
