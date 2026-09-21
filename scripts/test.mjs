import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prismaClientIsCurrent } from './prisma-current.mjs';

const root = process.cwd();
// file: 路径按 Prisma 约定相对 server/prisma/schema.prisma 解析，落到 server/data/test.db。
const databaseUrl = 'file:../data/test.db';
const databasePath = resolve(root, 'server/data/test.db');

await mkdir(dirname(databasePath), { recursive: true });
await rm(databasePath, { force: true });

const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
const runScript = (script, ...flags) => {
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', `npm run ${[script, ...flags].join(' ')}`] : ['run', script, ...flags];
  execFileSync(command, args, { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'inherit' });
};

if (!await prismaClientIsCurrent(root)) runScript('prisma:generate');
runScript('db:migrate');
runScript('test', '-w', 'server');
runScript('test', '-w', 'client');
