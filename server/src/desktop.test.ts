import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import supertest from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { app } from './app.js';
import { connectionConfiguration } from './application/security.js';
import { desktopMcpCommand, sqliteDatabaseUrl } from './application/desktop-paths.js';
import { mountDesktopStatic } from './desktop-static.js';

const previous = {
  packaged: process.env.WWA_PACKAGED,
  data: process.env.WWA_DATA_DIR,
  port: process.env.PORT,
  database: process.env.DATABASE_URL,
};

afterEach(() => {
  restore('WWA_PACKAGED', previous.packaged);
  restore('WWA_DATA_DIR', previous.data);
  restore('PORT', previous.port);
  restore('DATABASE_URL', previous.database);
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('desktop connection configuration', () => {
  it('keeps the development node entry on the dev API port', () => {
    delete process.env.WWA_PACKAGED;
    delete process.env.PORT;
    const config = connectionConfiguration('secret');
    expect(config.command).toBe(process.execPath);
    expect(config.args[0]).toMatch(/dist\/mcp\/index\.js$/);
    expect(config.env.WWA_API_URL).toBe('http://127.0.0.1:3016');
    expect(config.url).toBe('http://127.0.0.1:3016/mcp');
  });

  it('points a packaged app at the stable launcher and desktop port', () => {
    process.env.WWA_PACKAGED = '1';
    process.env.WWA_DATA_DIR = '/tmp/Library/Application Support/work-with-agent';
    delete process.env.PORT;
    const config = connectionConfiguration('secret');
    expect(config.command).toBe('/tmp/Library/Application Support/work-with-agent/bin/wwa-mcp');
    expect(config.args).toEqual([]);
    expect(config.env.WWA_API_URL).toBe('http://127.0.0.1:47316');
    expect(config.env.WWA_CONNECTION_TOKEN).toBe('secret');
    expect(config.url).toBe('http://127.0.0.1:47316/mcp');
    expect(desktopMcpCommand()).toBe(config.command);
  });
});

describe('desktop static hosting', () => {
  it('does not serve the client until a static directory is mounted', async () => {
    const response = await supertest(app).get('/');
    expect(response.status).toBe(404);
  });

  it('serves the built page without taking API or MCP routes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wwa-static-'));
    await writeFile(join(directory, 'index.html'), '<!doctype html><title>wwa-desktop</title>');
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'assets/app.js'), 'console.log("wwa")');
    const host = express();
    host.get('/api/health', (_req, res) => res.json({ ok: true }));
    host.post('/mcp', (_req, res) => res.status(406).json({ mcp: true }));
    mountDesktopStatic(host, directory);
    try {
      const page = await supertest(host).get('/');
      expect(page.status).toBe(200);
      expect(page.text).toContain('wwa-desktop');
      expect(page.headers['content-type']).toContain('text/html');
      expect((await supertest(host).get('/assets/app.js')).text).toContain('console.log');
      expect((await supertest(host).get('/api/health')).body).toEqual({ ok: true });
      expect((await supertest(host).post('/mcp')).status).toBe(406);
      const missing = await supertest(host).get('/api/missing');
      expect(missing.status).toBe(404);
      expect(missing.text).not.toContain('wwa-desktop');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('desktop data import', () => {
  it('copies a database into an empty directory and refuses to overwrite it', async () => {
    const source = await mkdtemp(join(tmpdir(), 'wwa-import-src-'));
    const destination = await mkdtemp(join(tmpdir(), 'wwa-import-dst-'));
    await writeFile(join(source, 'agent-studio.db'), 'sqlite-copy');
    await mkdir(join(source, 'knowledge-blobs'));
    await writeFile(join(source, 'knowledge-blobs/blob'), 'blob');
    const script = fileURLToPath(new URL('../../scripts/import-desktop-data.mjs', import.meta.url));
    const run = () => execFileSync(process.execPath, [script, '--source-dir', source, '--data-dir', destination], { encoding: 'utf8' });
    try {
      expect(run()).toContain(destination);
      expect(await readFile(join(destination, 'agent-studio.db'), 'utf8')).toBe('sqlite-copy');
      expect(await readFile(join(destination, 'knowledge-blobs/blob'), 'utf8')).toBe('blob');
      expect(() => run()).toThrow(/拒绝覆盖/);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  });
});

describe('desktop database migration', () => {
  it('migrates a copied database whose path contains spaces', async () => {
    const devDb = fileURLToPath(new URL('../data/agent-studio.db', import.meta.url));
    const devBefore = await stat(devDb).catch(() => null);
    const root = await mkdtemp(join(tmpdir(), 'wwa-migrate-'));
    const plain = join(root, 'plain', 'agent-studio.db');
    const copy = join(root, 'Application Support', 'agent-studio.db');
    await mkdir(join(root, 'plain'), { recursive: true });
    const { migrateDatabase } = await import('./db-migrate.js');
    try {
      await migrateDatabase(sqliteDatabaseUrl(plain));
      await mkdir(join(root, 'Application Support'), { recursive: true });
      await cp(plain, copy);
      const datasourceUrl = sqliteDatabaseUrl(copy);
      await migrateDatabase(datasourceUrl);
      const prisma = new PrismaClient({ datasourceUrl });
      try {
        const tables = await prisma.$queryRaw<Array<{ name: string }>>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'topics'`;
        expect(tables).toHaveLength(1);
        const devAfter = await stat(devDb).catch(() => null);
        expect(devAfter?.mtimeMs).toBe(devBefore?.mtimeMs);
      } finally {
        await prisma.$disconnect();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
