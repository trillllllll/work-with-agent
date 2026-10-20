import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import supertest from 'supertest';
import request from './test-auth.js';
import { ownerSession } from './test-auth.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './app.js';
import { prisma } from './services.js';
import { MOBILE_NAVIGATION_VIEWS } from './domain/mobile-navigation.js';
import { migrateDatabase } from './db-migrate.js';

const path = '/api/settings/mobile-navigation';
const defaults = ['inbox', 'today', 'quadrant', 'topics'];
const migrations = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));

describe('mobile navigation', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    await prisma.appSetting.deleteMany();
  });

  it('returns defaults without creating a row', async () => {
    const response = await request(app).get(path);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: { visibleViews: defaults },
      error: null,
    });
    expect(await prisma.appSetting.count()).toBe(0);
  });

  it('persists exact order and empty selection', async () => {
    for (const visibleViews of [
      ['plan', 'focus', 'inbox'],
      [],
    ]) {
      const response = await request(app)
        .put(path)
        .send({ visibleViews });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        data: { visibleViews },
        error: null,
      });

      const row = await prisma.appSetting.findUniqueOrThrow({
        where: { id: 'default' },
      });
      expect(row.mobileNavigationJson)
        .toBe(JSON.stringify(visibleViews));

      const loaded = await request(app).get(path);
      expect(loaded.body.data.visibleViews).toEqual(visibleViews);
    }
  });

  it.each([
    {},
    { visibleViews: null },
    { visibleViews: 'inbox' },
    { visibleViews: ['inbox', 'inbox'] },
    { visibleViews: ['more'] },
    { visibleViews: ['board'] },
    { visibleViews: ['knowledge'] },
    { visibleViews: ['unknown'] },
    { visibleViews: [1] },
    {
      visibleViews: [
        'inbox', 'today', 'quadrant', 'topics', 'plan',
      ],
    },
    { visibleViews: [], extra: true },
  ])('rejects invalid input without writing: %j', async (input) => {
    const response = await request(app).put(path).send(input);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      data: null,
      error: '手机底栏配置无效：请选择最多 4 个不重复的有效入口。',
    });
    expect(await prisma.appSetting.count()).toBe(0);
  });

  it('does not overwrite model or CLI settings', async () => {
    await prisma.appSetting.create({
      data: {
        id: 'default',
        openaiBaseUrl: 'https://example.invalid/v1',
        openaiModel: 'existing-model',
        openaiApiKey: 'existing-key',
        codexManualCommand: 'existing-codex',
        claudeManualCommand: 'existing-claude',
      },
    });

    const before = await prisma.appSetting.findUniqueOrThrow({
      where: { id: 'default' },
    });

    expect(
      (await request(app).put(path).send({ visibleViews: ['focus'] }))
        .status,
    ).toBe(200);

    const after = await prisma.appSetting.findUniqueOrThrow({
      where: { id: 'default' },
    });

    const {
      mobileNavigationJson: beforeNavigation,
      updatedAt: beforeUpdated,
      ...beforeStable
    } = before;

    const {
      mobileNavigationJson: afterNavigation,
      updatedAt: afterUpdated,
      ...afterStable
    } = after;

    expect(afterStable).toEqual(beforeStable);
    expect(afterNavigation).toBe('["focus"]');
  });

  it.each([
    'not-json',
    '{}',
    '["more"]',
    '["inbox","inbox"]',
    '["inbox","today","quadrant","topics","focus"]',
  ])('reads corrupt stored configuration safely: %s', async (raw) => {
    await prisma.appSetting.create({
      data: { id: 'default', mobileNavigationJson: raw },
    });

    const response = await request(app).get(path);
    expect(response.status).toBe(200);
    expect(response.body.data.visibleViews).toEqual(defaults);

    const row = await prisma.appSetting.findUniqueOrThrow({
      where: { id: 'default' },
    });
    expect(row.mobileNavigationJson).toBe(raw);
  });

  it('缺少登录、缺少 CSRF 或非 owner 都不能读写', async () => {
    expect((await request(app).put(path).send({ visibleViews: ['focus'] })).status).toBe(200);
    expect((await supertest(app).get(path)).status).toBe(401);
    expect((await supertest(app).put(path).send({ visibleViews: [] })).status).toBe(401);
    const session = await ownerSession(app);
    expect((await supertest(app).put(path).set('Cookie', session.cookie).send({ visibleViews: [] })).status).toBe(403);
    const connection = await supertest(app).post('/api/v1/connections').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ name: '底栏外部连接', host: 'codex', topicIds: [], includeInbox: false, autoActions: [] });
    expect(connection.status).toBe(200);
    const token = connection.body.data.token as string;
    try {
      expect((await supertest(app).get(path).set('Authorization', `Bearer ${token}`)).status).toBe(403);
      expect((await supertest(app).put(path).set('Authorization', `Bearer ${token}`).send({ visibleViews: [] })).status).toBe(403);
      expect((await request(app).get(path)).body.data.visibleViews).toEqual(['focus']);
    } finally {
      await prisma.connection.deleteMany({ where: { id: connection.body.data.id } });
    }
  });

  it('非法 PUT 不会改动已保存的配置字符串', async () => {
    expect((await request(app).put(path).send({ visibleViews: ['plan', 'focus'] })).status).toBe(200);
    const saved = (await prisma.appSetting.findUniqueOrThrow({ where: { id: 'default' } })).mobileNavigationJson;
    expect((await request(app).put(path).send({ visibleViews: ['plan', 'plan'] })).status).toBe(400);
    expect((await request(app).put(path).send({ visibleViews: ['plan', 'focus'], extra: 1 })).status).toBe(400);
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { id: 'default' } })).mobileNavigationJson).toBe(saved);
  });

  it('19 个白名单 ID 分别单独保存都成功', async () => {
    for (const view of MOBILE_NAVIGATION_VIEWS) {
      const response = await request(app).put(path).send({ visibleViews: [view] });
      expect(response.status, view).toBe(200);
      expect(response.body.data.visibleViews).toEqual([view]);
    }
  });

  it('导航保存不触发模型连接测试，模型保存不改动导航配置', async () => {
    const calls = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      expect(body.stream).toBe(false);
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '连接成功' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', calls);
    try {
      expect((await request(app).patch('/api/settings').send({ baseUrl: 'https://api.example.com/v1', model: 'example-model', apiKey: 'seed-key-123' })).status).toBe(200);
      const seeded = (await prisma.appSetting.findUniqueOrThrow({ where: { id: 'default' } })).mobileNavigationJson;
      expect(seeded).toBe('["inbox","today","quadrant","topics"]');
      const callsAfterModel = calls.mock.calls.length;

      expect((await request(app).put(path).send({ visibleViews: ['focus', 'chat'] })).status).toBe(200);
      expect((await request(app).get(path)).body.data.visibleViews).toEqual(['focus', 'chat']);
      expect(calls.mock.calls.length).toBe(callsAfterModel);

      expect((await request(app).patch('/api/settings').send({ baseUrl: 'https://api.example.com/v2', model: 'another-model' })).status).toBe(200);
      expect(calls.mock.calls.length).toBeGreaterThan(callsAfterModel);
      const row = await prisma.appSetting.findUniqueOrThrow({ where: { id: 'default' } });
      expect(row.mobileNavigationJson).toBe('["focus","chat"]');
      expect(row.openaiBaseUrl).toBe('https://api.example.com/v2');
      expect(row.openaiModel).toBe('another-model');
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      vi.unstubAllGlobals();
    }
  });

  afterAll(async () => {
    await prisma.appSetting.deleteMany();
  });
});

describe('手机底栏迁移', () => {
  it('旧库升级只补默认列，旧行与任务逐字保留，迁移可重复运行', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wwa-mnav-'));
    const file = join(directory, 'old.db');
    const databaseUrl = `file:${file}`;
    const db = new DatabaseSync(file);
    try {
      const names = readdirSync(migrations).filter((name) => name !== 'migration_lock.toml' && name < '20261014010000_mobile_navigation').sort();
      for (const name of names) db.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'));
      db.exec(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "checksum" TEXT NOT NULL,
        "finished_at" DATETIME,
        "migration_name" TEXT NOT NULL,
        "logs" TEXT,
        "rolled_back_at" DATETIME,
        "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
        "applied_steps_count" INTEGER NOT NULL DEFAULT 0
      )`);
      const insert = db.prepare('INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES (?, ?, ?, ?, ?, 1)');
      for (const name of names) {
        const checksum = createHash('sha256').update(readFileSync(join(migrations, name, 'migration.sql'))).digest('hex');
        insert.run(randomUUID(), checksum, '2026-10-01 00:00:00', name, '2026-10-01 00:00:00');
      }
      db.prepare(`INSERT INTO app_settings (id, openai_base_url, openai_api_key, openai_model, codex_manual_command, claude_manual_command, created_at, updated_at)
        VALUES ('default', 'https://model.example/v1', 'legacy-key', 'legacy-model', '/usr/bin/codex', '/usr/bin/claude', '2026-10-01', '2026-10-02')`).run();
      db.prepare(`INSERT INTO tasks (id, title, description, status, priority, due_date, deleted_at, created_at, updated_at)
        VALUES ('keep-task', '迁移前的任务', '说明还在', 'doing', 'high', '2026-10-10', NULL, '2026-10-01', '2026-10-02')`).run();
    } finally {
      db.close();
    }
    try {
      await migrateDatabase(databaseUrl);
      const client = new PrismaClient({ datasourceUrl: databaseUrl });
      try {
        const columns = await client.$queryRawUnsafe('PRAGMA table_info("app_settings")') as Array<{ name: string; notnull: number | bigint; dflt_value: string }>;
        const column = columns.find((row) => row.name === 'mobile_navigation_json');
        expect(column).toBeDefined();
        expect(Number(column!.notnull)).toBe(1);
        // PRAGMA 返回的默认值带 SQL 字面量引号。
        expect(JSON.parse(column!.dflt_value.replace(/^'|'$/g, ''))).toEqual(defaults);

        const row = await client.appSetting.findUniqueOrThrow({ where: { id: 'default' } });
        expect(row.mobileNavigationJson).toBe('["inbox","today","quadrant","topics"]');
        expect(row.openaiBaseUrl).toBe('https://model.example/v1');
        expect(row.openaiApiKey).toBe('legacy-key');
        expect(row.openaiModel).toBe('legacy-model');
        expect(row.codexManualCommand).toBe('/usr/bin/codex');
        expect(row.claudeManualCommand).toBe('/usr/bin/claude');
        expect(row.createdAt).toBe('2026-10-01');
        expect(row.updatedAt).toBe('2026-10-02');

        const tasks = await client.task.findMany();
        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toMatchObject({ id: 'keep-task', title: '迁移前的任务', description: '说明还在', status: 'doing', priority: 'high', dueDate: '2026-10-10' });
      } finally {
        await client.$disconnect();
      }
      await migrateDatabase(databaseUrl);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
