import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prismaClientIsCurrent } from '../scripts/prisma-current.mjs';

const root = process.cwd();
const databasePath = resolve(root, 'e2e/.data/agent-studio-e2e.db');
await mkdir(dirname(databasePath), { recursive: true });
await rm(databasePath, { force: true });
const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
const runScript = (script) => {
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', `npm run ${script}`] : ['run', script];
  execFileSync(command, args, { cwd: root, env: { ...process.env, DATABASE_URL: 'file:../../e2e/.data/agent-studio-e2e.db' }, stdio: 'inherit' });
};

if (!await prismaClientIsCurrent(root)) runScript('prisma:generate');
runScript('db:migrate');
