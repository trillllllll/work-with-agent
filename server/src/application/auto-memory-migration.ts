import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateDatabase } from '../db-migrate.js';

const migrations = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
const autoMemoryMigration = '20261014020000_auto_memory';

export type AutoMemoryMigrationRehearsal = {
  before: string;
  afterFirst: string;
  afterSecond: string;
  migrationRows: number;
  jobCount: number;
  tables: string[];
};

function applySchemaBeforeAutoMemory(file: string) {
  const names = readdirSync(migrations).filter((name) => name !== 'migration_lock.toml' && name < autoMemoryMigration).sort();
  const db = new DatabaseSync(file);
  try {
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
    db.prepare('INSERT INTO topics (id, name, revision) VALUES (?, ?, ?)').run('auto-topic-1', '迁移清单', 3);
    db.prepare('INSERT INTO tasks (id, topic_id, title, description, status, result_summary, revision, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('auto-task-1', 'auto-topic-1', '迁移任务', '保持原描述', 'todo', '尚未完成', 2, 4);
    db.prepare('INSERT INTO Material (id, topicId, kind, title, revision, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run('auto-material-1', 'auto-topic-1', 'text', '迁移资料', 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    db.prepare('INSERT INTO MaterialVersion (id, materialId, revision, content, contentHash, createdAt) VALUES (?, ?, 1, ?, ?, ?)').run('auto-version-1', 'auto-material-1', '迁移正文', 'a'.repeat(64), '2026-10-01T00:00:00.000Z');
    db.prepare('INSERT INTO Memory (id, topicId, kind, title, content, status, revision, evidence, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('auto-memory-1', 'auto-topic-1', 'fact', '迁移记忆', '长期事实', 'active', 2, '[]', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    db.prepare('INSERT INTO MemoryVersion (id, memoryId, revision, title, content, kind, status, health, evidence, reason, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('auto-memory-version-1', 'auto-memory-1', 2, '迁移记忆', '长期事实', 'fact', 'active', 'current', '[]', '人工记录', '2026-10-01T00:00:00.000Z');
    db.prepare('INSERT INTO WorkingBrief (id, topicId, content, manualNotes, revision, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run('topic:auto-topic-1', 'auto-topic-1', '固定正文', '不要覆盖', 4, '2026-10-01T00:00:00.000Z');
    db.prepare('INSERT INTO app_data_migrations (name, completed_at) VALUES (?, ?)').run('library-organization-v1', '2026-10-01T00:00:00.000Z');
    db.prepare('INSERT INTO app_data_migrations (name, completed_at) VALUES (?, ?)').run('unified-task-schedule-v1', '2026-10-01T00:00:00.000Z');
    return businessSnapshot(db);
  } finally {
    db.close();
  }
}

function businessSnapshot(db: DatabaseSync) {
  return JSON.stringify({
    topic: db.prepare('SELECT id, name, revision, description, goal FROM topics ORDER BY id').all(),
    task: db.prepare('SELECT id, topic_id, title, description, status, result_summary, revision, sort_order, due_date FROM tasks ORDER BY id').all(),
    material: db.prepare('SELECT id, topicId, kind, title, revision, archivedAt FROM Material ORDER BY id').all(),
    version: db.prepare('SELECT id, materialId, revision, content, contentHash FROM MaterialVersion ORDER BY id').all(),
    memory: db.prepare('SELECT id, topicId, kind, title, content, status, revision, evidence FROM Memory ORDER BY id').all(),
    memoryVersion: db.prepare('SELECT id, memoryId, revision, title, content, kind, status, reason FROM MemoryVersion ORDER BY id').all(),
    brief: db.prepare('SELECT id, topicId, content, manualNotes, revision FROM WorkingBrief ORDER BY id').all(),
  });
}

/** Upgrade an isolated pre-auto-memory database twice. Never touches a user database. */
export async function rehearseAutoMemoryMigration(): Promise<AutoMemoryMigrationRehearsal> {
  const directory = await mkdtemp(join(tmpdir(), 'wwa-auto-memory-migration-'));
  const file = join(directory, 'migrate.db');
  const before = applySchemaBeforeAutoMemory(file);
  try {
    await migrateDatabase(`file:${file}`);
    const first = new DatabaseSync(file);
    let afterFirst = '';
    let tables: string[] = [];
    try {
      afterFirst = businessSnapshot(first);
      tables = (first.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('AutoMemoryScope', 'AutoMemorySource', 'AutoMemoryJob', 'AutoMemoryTurn', 'MemorySuggestionKey') ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    } finally {
      first.close();
    }
    await migrateDatabase(`file:${file}`);
    const second = new DatabaseSync(file);
    try {
      const afterSecond = businessSnapshot(second);
      const migrationRows = (second.prepare('SELECT COUNT(*) AS count FROM _prisma_migrations WHERE migration_name = ?').get(autoMemoryMigration) as { count: number }).count;
      const jobCount = (second.prepare('SELECT COUNT(*) AS count FROM AutoMemoryJob').get() as { count: number }).count;
      return { before, afterFirst, afterSecond, migrationRows, jobCount, tables };
    } finally {
      second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
