import { mkdtempSync, existsSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';

/**
 * Snapshot tests need a fully disposable database: the import path replaces the
 * database file. Modules load dynamically only after the scratch environment is
 * in place, and vitest's per-file isolation keeps other suites untouched.
 */

let scratch = '';
let app: typeof import('./app.js')['app'];
let snapshots: typeof import('./application/snapshots.js');
let security: typeof import('./application/security.js');
let blobs: typeof import('./application/knowledge-blobs.js');
let sessionCookie = '';
let csrf = '';
let previousDatabaseUrl: string | undefined;
let previousDataDir: string | undefined;
let previousBlobRoot: string | undefined;

beforeAll(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  previousDataDir = process.env.DOVUN_DATA_DIR;
  previousBlobRoot = process.env.KNOWLEDGE_STORAGE_ROOT;
  scratch = mkdtempSync(join(tmpdir(), 'wwa-snapshot-'));
  await mkdir(join(scratch, 'source'), { recursive: true });
  process.env.DATABASE_URL = `file:${join(scratch, 'source', 'agent-studio.db')}`;
  process.env.DOVUN_DATA_DIR = join(scratch, 'source-data');
  process.env.KNOWLEDGE_STORAGE_ROOT = join(scratch, 'source-blobs');
  const { migrateDatabase } = await import('./db-migrate.js');
  await migrateDatabase(process.env.DATABASE_URL);
  app = (await import('./app.js')).app;
  snapshots = await import('./application/snapshots.js');
  security = await import('./application/security.js');
  blobs = await import('./application/knowledge-blobs.js');

  const login = await supertest(app).post('/api/v1/auth/session').send({ bootstrapToken: security.createOwnerBootstrapToken() });
  expect(login.status).toBe(200);
  sessionCookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  csrf = login.body.data.csrfToken as string;
  const topic = await supertest(app).post('/api/topics').set('Cookie', sessionCookie).set('X-CSRF-Token', csrf).send({ name: '快照测试清单' });
  expect(topic.status).toBe(200);
  await blobs.storeKnowledgeBlob(Buffer.from('attachment-bytes'));
}, 180_000);

afterAll(async () => {
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousDataDir === undefined) delete process.env.DOVUN_DATA_DIR;
  else process.env.DOVUN_DATA_DIR = previousDataDir;
  if (previousBlobRoot === undefined) delete process.env.KNOWLEDGE_STORAGE_ROOT;
  else process.env.KNOWLEDGE_STORAGE_ROOT = previousBlobRoot;
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
});

function owner() {
  return { Cookie: sessionCookie, 'X-CSRF-Token': csrf };
}

/** superagent does not buffer unknown content types on its own. */
function binaryParser(res: import('superagent').Response, callback: (error: Error | null, body?: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
  res.on('error', (error: Error) => callback(error));
}

function getSnapshotZip() {
  return supertest(app).get('/api/v1/server/snapshot').set(owner()).parse(binaryParser);
}

describe('snapshot export', () => {
  it('downloads a zip with manifest, database, and blobs', async () => {
    const response = await getSnapshotZip();
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/zip');
    expect(response.headers['content-disposition']).toMatch(/dovun-snapshot-.*\.zip/);
    const zip = await JSZip.loadAsync(response.body as Buffer);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.schemaVersion).toBe(snapshots.localSchemaVersion());
    expect(manifest.exportedAt).toBeTruthy();
    expect(zip.file('dovun.db')).toBeTruthy();
    const names = Object.keys(zip.files).filter((name) => name.startsWith('knowledge-blobs/'));
    expect(names.some((name) => name.endsWith(blobs.knowledgeHash('attachment-bytes')))).toBe(true);
  }, 60_000);

  it('blocks anonymous downloads', async () => {
    const response = await supertest(app).get('/api/v1/server/snapshot');
    expect(response.status).toBe(401);
  });
});

describe('snapshot import', () => {
  it('rejects a broken archive', async () => {
    const response = await supertest(app).put('/api/v1/server/snapshot/import').set(owner()).set('Content-Type', 'application/zip').send(Buffer.from('not a zip'));
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('SNAPSHOT_INVALID');
  }, 60_000);

  it('rejects a snapshot from a newer schema', async () => {
    const future = new JSZip();
    future.file('manifest.json', JSON.stringify({ appVersion: '0.0.0', schemaVersion: '99999999999999_future', exportedAt: new Date().toISOString() }));
    future.file('agent-studio.db', Buffer.from('x'));
    const response = await supertest(app).put('/api/v1/server/snapshot/import').set(owner()).set('Content-Type', 'application/zip').send(await future.generateAsync({ type: 'nodebuffer' }));
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('SNAPSHOT_NEWER_SCHEMA');
  }, 60_000);

  it('restores a full export into a fresh data directory', async () => {
    const exported = await getSnapshotZip();
    const target = join(scratch, 'target');
    process.env.DATABASE_URL = `file:${join(target, 'agent-studio.db')}`;
    process.env.DOVUN_DATA_DIR = join(target, 'data');
    process.env.KNOWLEDGE_STORAGE_ROOT = join(target, 'blobs');

    const response = await supertest(app).put('/api/v1/server/snapshot/import').set(owner()).set('Content-Type', 'application/zip').send(exported.body as Buffer);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.imported).toBe(true);

    // The import backed up the live workspace before staging the restore.
    const { readdir } = await import('node:fs/promises');
    const backups = (await readdir(join(target, 'data', 'snapshots'))).filter((name) => name.startsWith('before-import-'));
    expect(backups.length).toBe(1);

    expect(existsSync(`${join(target, 'agent-studio.db')}.pending-import`)).toBe(true);
    expect(snapshots.applyPendingImport()).toBe(true);
    expect(existsSync(join(target, 'agent-studio.db'))).toBe(true);

    const restored = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    try {
      const topics = await restored.topic.findMany({ where: { name: '快照测试清单' } });
      expect(topics.length).toBe(1);
    } finally {
      await restored.$disconnect();
    }
    expect(existsSync(join(target, 'blobs', blobs.knowledgeHash('attachment-bytes')))).toBe(true);
  }, 120_000);
});

describe('snapshot merge', () => {
  it('adds missing rows, keeps existing ids, and does not replace the live database', async () => {
    process.env.DATABASE_URL = `file:${join(scratch, 'source', 'agent-studio.db')}`;
    process.env.DOVUN_DATA_DIR = join(scratch, 'source-data');
    process.env.KNOWLEDGE_STORAGE_ROOT = join(scratch, 'source-blobs');
    const source = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    try {
      await source.topic.create({ data: { id: 'topic-snap', name: '快照清单' } });
      await source.task.create({ data: { id: 'task-same', title: '快照里的标题', topicId: 'topic-snap' } });
      await source.task.create({ data: { id: 'task-snap-name', title: '同名任务', topicId: 'topic-snap' } });
      await source.entity.create({ data: { id: 'entity-snap', topicKey: 'same-key', name: '同名概念', createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z' } });
      await source.appSetting.upsert({ where: { id: 'default' }, create: { id: 'default', openaiApiKey: 'snapshot-key', createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z' }, update: { openaiApiKey: 'snapshot-key' } });
    } finally {
      await source.$disconnect();
    }
    const extraBlob = await blobs.storeKnowledgeBlob(Buffer.from('only-in-snapshot'));
    const exported = await getSnapshotZip();

    const target = join(scratch, 'merge-target');
    await mkdir(target, { recursive: true });
    const targetUrl = `file:${join(target, 'agent-studio.db')}`;
    process.env.DATABASE_URL = targetUrl;
    process.env.DOVUN_DATA_DIR = join(target, 'data');
    process.env.KNOWLEDGE_STORAGE_ROOT = join(target, 'blobs');
    const { migrateDatabase } = await import('./db-migrate.js');
    await migrateDatabase(targetUrl);
    const live = new PrismaClient({ datasourceUrl: targetUrl });
    try {
      await live.topic.create({ data: { id: 'topic-live', name: '当前清单' } });
      await live.topic.create({ data: { id: 'topic-only-live', name: '只在当前' } });
      await live.task.create({ data: { id: 'task-same', title: '当前库标题', topicId: 'topic-live' } });
      await live.task.create({ data: { id: 'task-live-name', title: '同名任务', topicId: 'topic-live' } });
      await live.entity.create({ data: { id: 'entity-live', topicKey: 'same-key', name: '同名概念', createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z' } });
      await live.appSetting.upsert({ where: { id: 'default' }, create: { id: 'default', openaiApiKey: 'live-key', createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z' }, update: { openaiApiKey: 'live-key' } });
    } finally {
      await live.$disconnect();
    }
    const existingBlob = join(target, 'blobs', blobs.knowledgeHash('attachment-bytes'));
    await mkdir(join(target, 'blobs'), { recursive: true });
    writeFileSync(existingBlob, Buffer.from('attachment-bytes'));
    const earlier = new Date('2020-01-01T00:00:00Z');
    utimesSync(existingBlob, earlier, earlier);

    const response = await supertest(app).put('/api/v1/server/snapshot/import?mode=merge').set(owner()).set('Content-Type', 'application/zip').send(exported.body as Buffer);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.mode).toBe('merge');
    expect(response.body.data.inserted).toBeGreaterThan(0);
    expect(response.body.data.skipped).toBeGreaterThan(0);
    expect(existsSync(`${join(target, 'agent-studio.db')}.pending-import`)).toBe(false);

    const merged = new PrismaClient({ datasourceUrl: targetUrl });
    try {
      expect(await merged.topic.findMany({ where: { id: { in: ['topic-snap', 'topic-live', 'topic-only-live'] } }, select: { id: true }, orderBy: { id: 'asc' } })).toEqual([
        { id: 'topic-live' },
        { id: 'topic-only-live' },
        { id: 'topic-snap' },
      ]);
      expect((await merged.task.findUniqueOrThrow({ where: { id: 'task-same' } })).title).toBe('当前库标题');
      expect(await merged.task.count({ where: { id: 'task-same' } })).toBe(1);
      expect(await merged.task.count({ where: { title: '同名任务' } })).toBe(2);
      expect(await merged.entity.findMany({ where: { topicKey: 'same-key', name: '同名概念' }, select: { id: true } })).toEqual([{ id: 'entity-live' }]);
      expect((await merged.appSetting.findUniqueOrThrow({ where: { id: 'default' } })).openaiApiKey).toBe('live-key');
    } finally {
      await merged.$disconnect();
    }
    expect(statSync(existingBlob).mtime.toISOString()).toBe(earlier.toISOString());
    expect(existsSync(join(target, 'blobs', extraBlob))).toBe(true);
  }, 120_000);
});

describe('seed snapshot', () => {
  it('imports seed.zip on first boot and ignores it afterwards', async () => {
    const exported = await getSnapshotZip();
    const area = join(scratch, 'seed-area');
    process.env.DATABASE_URL = `file:${join(area, 'agent-studio.db')}`;
    process.env.DOVUN_DATA_DIR = join(area, 'data');
    process.env.KNOWLEDGE_STORAGE_ROOT = join(area, 'blobs');
    await mkdir(join(area, 'data', 'snapshots'), { recursive: true });
    writeFileSync(join(area, 'data', 'snapshots', 'seed.zip'), exported.body as Buffer);

    const result = await snapshots.maybeSeedSnapshot();
    expect(result).not.toBeNull();
    expect(existsSync(join(area, 'agent-studio.db'))).toBe(true);
    expect(existsSync(join(area, 'data', 'snapshots', 'seed.zip'))).toBe(false);

    // A second boot with a database present does nothing.
    writeFileSync(join(area, 'data', 'snapshots', 'seed.zip'), exported.body as Buffer);
    expect(await snapshots.maybeSeedSnapshot()).toBeNull();
  }, 60_000);
});
