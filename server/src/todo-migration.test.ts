import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrations = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
const migrationNames = readdirSync(migrations, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
function migrate(db: DatabaseSync, name: string) {
  db.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'));
}

describe('basic Todo explicit SQLite migration', () => {
  it('applies the complete migration chain to a fresh database', () => {
    const db = new DatabaseSync(':memory:');
    try {
      for (const name of migrationNames) migrate(db, name);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
      expect(tables).toEqual(expect.arrayContaining(['tasks', 'topics', 'tags', 'task_tags', 'task_topic_assignments', 'change_records', 'approvals', 'Connection', 'RequestReceipt', 'Proposal', 'Material', 'MaterialVersion', 'Memory', 'MemoryVersion', 'Handoff', 'Run', 'Artifact', 'ReviewRule', 'ReviewBatch']));
      expect(db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name)).toEqual(expect.arrayContaining(['parent_id', 'sort_order', 'revision', 'delete_batch_id']));
    } finally { db.close(); }
  });

  it('upgrades existing rows without changing IDs, statuses, summaries, history, approvals with actor-scoped idempotency', () => {
    const db = new DatabaseSync(':memory:');
    try {
      for (const name of migrationNames.filter((name) => name < '20260920000000_domain_modeling')) migrate(db, name);
      db.exec(`
        INSERT INTO topics (id, name, final_summary, summary_status, created_at, updated_at)
        VALUES ('legacy-list', '旧清单', '已经确认的旧成果', 'confirmed', '2026-09-01', '2026-09-03');
        INSERT INTO tasks (id, topic_id, title, status, priority, due_date, deleted_at, created_at, updated_at)
        VALUES ('older', 'legacy-list', '旧任务', 'blocked', 'high', '2026-09-20', NULL, '2026-09-01', '2026-09-02'),
               ('newer', 'legacy-list', '新任务', 'done', 'none', NULL, NULL, '2026-09-01', '2026-09-03'),
               ('trashed', 'legacy-list', '旧回收站', 'doing', 'low', NULL, '2026-09-04', '2026-09-01', '2026-09-04'),
               ('inbox', NULL, '收集箱任务', 'todo', 'none', NULL, NULL, '2026-09-01', '2026-09-03');
        INSERT INTO approvals (id, tool_name, arguments, status) VALUES ('approval-old', 'create_task', '{"title":"待审核"}', 'pending');
        INSERT INTO change_records (id, entity_type, entity_id, operation, before_snapshot, after_snapshot, source, request_id)
        VALUES ('change-old', 'task', 'older', 'update', '{"title":"之前"}', '{"title":"旧任务"}', 'user', 'request-old');
      `);
      migrate(db, '20260920000000_domain_modeling');
      const assignmentsBefore = db.prepare('SELECT * FROM task_topic_assignments ORDER BY id').all();
      const changeBefore = db.prepare('SELECT * FROM change_records WHERE id = ?').get('change-old');
      for (const name of migrationNames.filter((name) => name > '20260920000000_domain_modeling')) migrate(db, name);

      expect(db.prepare('SELECT id, status, priority, due_date FROM tasks WHERE id = ?').get('older')).toMatchObject({ id: 'older', status: 'blocked', priority: 'high', due_date: '2026-09-20' });
      expect(db.prepare('SELECT final_summary, summary_status FROM topics WHERE id = ?').get('legacy-list')).toMatchObject({ final_summary: '已经确认的旧成果', summary_status: 'confirmed' });
      expect(db.prepare('SELECT id FROM tasks WHERE topic_id = ? AND deleted_at IS NULL ORDER BY sort_order, id').all('legacy-list').map((row) => row.id)).toEqual(['newer', 'older']);
      expect(db.prepare('SELECT parent_id, revision, delete_batch_id FROM tasks WHERE id = ?').get('older')).toMatchObject({ parent_id: null, revision: 1, delete_batch_id: null });
      expect(db.prepare('SELECT id FROM tasks ORDER BY id').all().map((row) => row.id)).toEqual(['inbox', 'newer', 'older', 'trashed']);
      expect(db.prepare('SELECT * FROM task_topic_assignments ORDER BY id').all()).toEqual(assignmentsBefore);
      expect(db.prepare('SELECT * FROM change_records WHERE id = ?').get('change-old')).toMatchObject(changeBefore!);
      expect(db.prepare('SELECT status, arguments FROM approvals WHERE id = ?').get('approval-old')).toMatchObject({ status: 'pending', arguments: '{"title":"待审核"}' });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name)).toEqual(expect.arrayContaining(['RequestReceipt_actorId_requestId_key', 'tasks_topic_id_idx', 'tasks_deleted_at_idx', 'task_topic_assignments_task_id_changed_at_idx']));
      expect(() => db.prepare("INSERT INTO change_records (id, entity_type, entity_id, operation, source, request_id) VALUES ('duplicate', 'task', 'older', 'update', 'user', 'request-old')").run()).not.toThrow();
      db.prepare("INSERT INTO RequestReceipt (id, actorId, requestId, requestHash, response, createdAt) VALUES ('receipt-one', 'owner', 'request-old', 'hash', '{}', '2026-09-21')").run();
      expect(() => db.prepare("INSERT INTO RequestReceipt (id, actorId, requestId, requestHash, response, createdAt) VALUES ('receipt-two', 'owner', 'request-old', 'hash', '{}', '2026-09-21')").run()).toThrow();
      expect(() => db.prepare("INSERT INTO RequestReceipt (id, actorId, requestId, requestHash, response, createdAt) VALUES ('receipt-three', 'another-connection', 'request-old', 'hash', '{}', '2026-09-21')").run()).not.toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });
});
