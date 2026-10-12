import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import supertest from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import request, { ownerSession } from './test-auth.js';
import { migrateDatabase } from './db-migrate.js';

const path = '/api/plan/time-bands';
const valid = {
  id: '00000000-0000-4000-8000-000000000001',
  name: '工作',
  startMinute: 540,
  endMinute: 1080,
  weekdays: [1, 2, 3, 4, 5],
  color: 'blue',
};
const migrations = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));

beforeEach(async () => {
  await prisma.planTimeBand.deleteMany();
});
afterAll(async () => {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_plan_time_band_insert');
});

async function savedBands() {
  return (await request(app).get(path)).body.data.bands;
}

describe('规划时间段 API', () => {
  it('整体替换、拒绝非法写入并可以清空', async () => {
    expect((await request(app).get(path)).body).toEqual({
      data: { bands: [] },
      error: null,
    });

    const saved = await request(app)
      .put(path)
      .send({ bands: [valid] });

    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({
      data: { bands: [valid] },
      error: null,
    });

    expect((await request(app).get(path)).body).toEqual(saved.body);

    const bad = await request(app)
      .put(path)
      .send({ bands: [{ ...valid, endMinute: valid.startMinute }] });

    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
    expect((await request(app).get(path)).body).toEqual(saved.body);

    expect((await request(app).put(path).send({
      bands: [valid, valid],
    })).status).toBe(400);

    expect((await request(app).put(path).send({
      bands: [],
    })).status).toBe(200);

    expect((await request(app).get(path)).body.data.bands).toEqual([]);
  });

  it.each([
    ['空白名称', { bands: [{ ...valid, name: '   ' }] }],
    ['空名称', { bands: [{ ...valid, name: '' }] }],
    ['41 个字符', { bands: [{ ...valid, name: '名'.repeat(41) }] }],
    ['startMinute -1', { bands: [{ ...valid, startMinute: -1 }] }],
    ['startMinute 1440', { bands: [{ ...valid, startMinute: 1440 }] }],
    ['startMinute 1.5', { bands: [{ ...valid, startMinute: 1.5 }] }],
    ['startMinute 字符串', { bands: [{ ...valid, startMinute: '540' }] }],
    ['endMinute 0', { bands: [{ ...valid, endMinute: 0 }] }],
    ['endMinute 1441', { bands: [{ ...valid, endMinute: 1441 }] }],
    ['endMinute 等于开始', { bands: [{ ...valid, endMinute: 540 }] }],
    ['weekdays 空', { bands: [{ ...valid, weekdays: [] }] }],
    ['weekdays 0', { bands: [{ ...valid, weekdays: [0] }] }],
    ['weekdays 8', { bands: [{ ...valid, weekdays: [8] }] }],
    ['weekdays 重复', { bands: [{ ...valid, weekdays: [1, 1] }] }],
    ['weekdays 字符串', { bands: [{ ...valid, weekdays: ['1'] }] }],
    ['color red', { bands: [{ ...valid, color: 'red' }] }],
    ['id 不是 UUID', { bands: [{ ...valid, id: 'not-a-uuid' }] }],
    ['记录未知字段', { bands: [{ ...valid, note: 'extra' }] }],
    ['顶层未知字段', { bands: [valid], extra: true }],
    ['重复 ID', { bands: [valid, valid] }],
    ['101 条', { bands: Array.from({ length: 101 }, (_, index) => ({ ...valid, id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` })) }],
  ])('%s 返回 400 且数据库保持原样', async (_label, body) => {
    expect((await request(app).put(path).send({ bands: [valid] })).status).toBe(200);
    const bad = await request(app).put(path).send(body);
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ data: null, code: 'VALIDATION_ERROR' });
    expect(await savedBands()).toEqual([valid]);
  });

  it('接受 24:00，并返回 trim 后的名称与升序星期', async () => {
    const overnight = { ...valid, id: '00000000-0000-4000-8000-000000000002', name: '  通宵  ', startMinute: 1320, endMinute: 1440, weekdays: [5, 1, 3] };
    const saved = await request(app).put(path).send({ bands: [overnight, valid] });
    expect(saved.status).toBe(200);
    expect(saved.body.data.bands).toEqual([
      { ...overnight, name: '通宵', weekdays: [1, 3, 5] },
      valid,
    ]);
    expect((await prisma.planTimeBand.findFirst({ where: { id: overnight.id } }))?.weekdaysJson).toBe('[1,3,5]');
  });

  it('缺少登录、缺少 CSRF 或非 owner 都不能读写', async () => {
    expect((await request(app).put(path).send({ bands: [valid] })).status).toBe(200);
    expect((await supertest(app).get(path)).status).toBe(401);
    expect((await supertest(app).put(path).send({ bands: [] })).status).toBe(401);
    const session = await ownerSession(app);
    expect((await supertest(app).put(path).set('Cookie', session.cookie).send({ bands: [] })).status).toBe(403);
    const connection = await supertest(app).post('/api/v1/connections').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ name: '时间段外部', host: 'codex', topicIds: [], includeInbox: false, autoActions: [] });
    expect(connection.status).toBe(200);
    const token = connection.body.data.token as string;
    try {
      expect((await supertest(app).get(path).set('Authorization', `Bearer ${token}`)).status).toBe(403);
      expect((await supertest(app).put(path).set('Authorization', `Bearer ${token}`).send({ bands: [] })).status).toBe(403);
      expect(await savedBands()).toEqual([valid]);
    } finally {
      await prisma.connection.deleteMany({ where: { id: connection.body.data.id } });
    }
  });

  it('插入失败时回滚，之前的列表仍在', async () => {
    expect((await request(app).put(path).send({ bands: [valid] })).status).toBe(200);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER fail_plan_time_band_insert
      BEFORE INSERT ON plan_time_bands
      BEGIN
        SELECT RAISE(ROLLBACK, 'injected insert failure');
      END;
    `);
    try {
      const failed = await request(app).put(path).send({ bands: [{ ...valid, id: '00000000-0000-4000-8000-000000000009', name: '不会留下' }] });
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await savedBands()).toEqual([valid]);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_plan_time_band_insert');
    }
  });

  it('更换数据库连接后仍能读到已保存的数据', async () => {
    expect((await request(app).put(path).send({ bands: [valid] })).status).toBe(200);
    const fresh = new PrismaClient();
    try {
      const rows = await fresh.planTimeBand.findMany({ orderBy: { position: 'asc' } });
      expect(rows.map((row) => ({ id: row.id, name: row.name, startMinute: row.startMinute, endMinute: row.endMinute, weekdaysJson: row.weekdaysJson, color: row.color, position: row.position }))).toEqual([
        { id: valid.id, name: valid.name, startMinute: 540, endMinute: 1080, weekdaysJson: '[1,2,3,4,5]', color: 'blue', position: 0 },
      ]);
    } finally {
      await fresh.$disconnect();
    }
  });
});

describe('规划时间段迁移', () => {
  it('新数据库可以迁移，再次运行不报错', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wwa-bands-new-'));
    const databaseUrl = `file:${join(directory, 'fresh.db')}`;
    try {
      await migrateDatabase(databaseUrl);
      await migrateDatabase(databaseUrl);
      const client = new PrismaClient({ datasourceUrl: databaseUrl });
      try {
        expect(await client.planTimeBand.count()).toBe(0);
      } finally {
        await client.$disconnect();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it('升级旧数据库后原任务内容和数量不变，迁移可重复运行', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wwa-bands-old-'));
    const file = join(directory, 'old.db');
    const databaseUrl = `file:${file}`;
    const db = new DatabaseSync(file);
    try {
      const names = readdirSync(migrations).filter((name) => name !== 'migration_lock.toml' && name < '20261012010000_plan_time_bands').sort();
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
      db.prepare(`INSERT INTO tasks (id, title, description, status, result_summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('keep-1', '升级前的任务', '说明还在', 'doing', '成果还在', '2026-10-01', '2026-10-02');
      db.prepare(`INSERT INTO tasks (id, title, description, status, result_summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('keep-2', '第二条', '', 'todo', '', '2026-10-01', '2026-10-02');
    } finally {
      db.close();
    }
    try {
      await migrateDatabase(databaseUrl);
      const client = new PrismaClient({ datasourceUrl: databaseUrl });
      try {
        const tasks = await client.task.findMany({ orderBy: { id: 'asc' } });
        expect(tasks).toHaveLength(2);
        expect(tasks.map((task) => ({ id: task.id, title: task.title, description: task.description, status: task.status, resultSummary: task.resultSummary }))).toEqual([
          { id: 'keep-1', title: '升级前的任务', description: '说明还在', status: 'doing', resultSummary: '成果还在' },
          { id: 'keep-2', title: '第二条', description: '', status: 'todo', resultSummary: '' },
        ]);
        expect(await client.planTimeBand.count()).toBe(0);
      } finally {
        await client.$disconnect();
      }
      await migrateDatabase(databaseUrl);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
