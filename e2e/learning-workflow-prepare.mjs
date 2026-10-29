// Creates only this worktree's dedicated test database. Never use an inherited DATABASE_URL.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prismaClientIsCurrent } from '../scripts/prisma-current.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (resolve(process.cwd()) !== resolve(root) || process.env.LEARNING_WORKFLOW_E2E !== '1') {
  throw new Error('Use the dedicated learning workflow Playwright config from this worktree');
}
const databasePath = resolve(root, 'e2e/.data/learning-workflow.db');
const databaseUrl = `file:${databasePath}`;
if (process.env.DATABASE_URL !== databaseUrl) throw new Error('Refusing to prepare an unexpected database');
const apiPort = Number(process.env.LEARNING_E2E_API_PORT ?? 3038);
const isListening = port => new Promise(resolveListening => {
  const socket = createConnection({ host: '127.0.0.1', port });
  const finish = value => { socket.destroy(); resolveListening(value); };
  socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(800, () => finish(false));
});
if (await isListening(apiPort)) throw new Error('Refusing to reset the learning database while its API port is in use');
await mkdir(dirname(databasePath), { recursive: true });
for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(databasePath + suffix, { force: true });
const runScript = script => execFileSync('npm', ['run', script], {
  cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'inherit',
});
if (!await prismaClientIsCurrent(root)) runScript('prisma:generate');
runScript('db:migrate');
const { PrismaClient } = await import('@prisma/client');
const database = new PrismaClient({ datasourceUrl: databaseUrl });
const hash = value => createHash('sha256').update(value).digest('hex');
const fixtureSession = 'learning-workflow-fixture-session';
try {
  await database.localSession.create({ data: {
    id: 'learning-e2e-owner', tokenHash: hash(fixtureSession), csrfHash: hash(hash(`csrf:${fixtureSession}`)),
    expiresAt: '2099-01-01T00:00:00.000Z', createdAt: new Date().toISOString(),
  } });
  await database.appSetting.upsert({ where: { id: 'default' }, create: {
    id: 'default', openaiBaseUrl: `http://127.0.0.1:${process.env.LEARNING_E2E_MODEL_PORT ?? 4038}/v1`,
    openaiApiKey: 'isolated-fixture-not-a-real-key', openaiModel: 'learning-workflow-fixture',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }, update: {} });
} finally { await database.$disconnect(); }
