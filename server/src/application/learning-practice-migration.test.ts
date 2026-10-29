import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readdir, copyFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { migrateDatabase } from '../db-migrate.js';
describe('learning practice migration', () => {
  it('upgrades an old learning database and is repeatable without replacing notes or new attempts', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dovun-practice-migration-'));
    const url = `file:${join(folder, 'old.db')}`;
    new DatabaseSync(join(folder, 'old.db')).close();
    const original = fileURLToPath(new URL('../../prisma/', import.meta.url));
    const schema = join(folder, 'schema.prisma');
    await copyFile(join(original, 'schema.prisma'), schema);
    await mkdir(join(folder, 'migrations'));
    try {
      for (const name of await readdir(join(original, 'migrations'))) {
        if (name === '20261109000000_learning_practice')
          continue;
        const source = join(original, 'migrations', name);
        if (name.endsWith('.toml'))
          await copyFile(source, join(folder, 'migrations', name));
        else {
          await mkdir(join(folder, 'migrations', name));
          await copyFile(join(source, 'migration.sql'), join(folder, 'migrations', name, 'migration.sql'));
        }
      }
      execFileSync(process.execPath, [createRequire(import.meta.url).resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', schema], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
      const db = new PrismaClient({ datasourceUrl: url });
      try {
        const stamp = '2026-01-01T00:00:00.000Z';
        const map = await db.learningMap.create({ data: { title: '旧学习主题', goal: '保留原目标', createdAt: stamp, updatedAt: stamp } });
        const node = await db.learningNode.create({ data: { mapId: map.id, kind: 'item', title: '旧笔记', detail: '# 我的理解\n旧正文', status: 'done', revision: 7, createdAt: stamp, updatedAt: stamp } });
        const activity = await db.learningActivity.create({ data: { mapId: map.id, nodeId: node.id, kind: 'session', content: '旧学习记录', metaJson: '{"source":"legacy"}', createdAt: stamp } });
        await migrateDatabase(url);
        expect(await db.learningMap.findUnique({ where: { id: map.id } })).toEqual(map);
        expect(await db.learningNode.findUnique({ where: { id: node.id } })).toEqual(node);
        expect(await db.learningActivity.findUnique({ where: { id: activity.id } })).toEqual(activity);
        const draft = await db.learningAnswerDraft.create({ data: { itemId: 'migration-retained-item', activeAttemptId: 'migration-retained-attempt', answerJson: '"我自己的草稿"', revision: 3, updatedAt: stamp } });
        await migrateDatabase(url);
        expect(await db.learningAnswerDraft.findUnique({ where: { id: draft.id } })).toEqual(draft);
        expect(await db.learningNode.findUnique({ where: { id: node.id } })).toEqual(node);
        expect(await db.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
      }
      finally {
        await db.$disconnect();
      }
    }
    finally {
      await rm(folder, { recursive: true, force: true });
    }
  }, 30000);
});
