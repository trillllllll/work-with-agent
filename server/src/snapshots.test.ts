import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
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

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'wwa-snapshot-'));
  await mkdir(join(scratch, 'source'), { recursive: true });
  process.env.DATABASE_URL = `file:${join(scratch, 'source', 'agent-studio.db')}`;
  process.env.WWA_DATA_DIR = join(scratch, 'source-data');
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
    expect(response.headers['content-disposition']).toMatch(/wwa-snapshot-.*\.zip/);
    const zip = await JSZip.loadAsync(response.body as Buffer);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.schemaVersion).toBe(snapshots.localSchemaVersion());
    expect(manifest.exportedAt).toBeTruthy();
    expect(zip.file('agent-studio.db')).toBeTruthy();
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
    process.env.WWA_DATA_DIR = join(target, 'data');
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

describe('seed snapshot', () => {
  it('imports seed.zip on first boot and ignores it afterwards', async () => {
    const exported = await getSnapshotZip();
    const area = join(scratch, 'seed-area');
    process.env.DATABASE_URL = `file:${join(area, 'agent-studio.db')}`;
    process.env.WWA_DATA_DIR = join(area, 'data');
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
