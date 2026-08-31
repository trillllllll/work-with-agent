import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done';
const dbPath = resolve(process.env.SQLITE_PATH ?? './data/agent-studio.db');
mkdirSync(dirname(dbPath), { recursive: true });
export const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS topics (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', is_exploration INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE RESTRICT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','blocked','done')), result_summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tasks_topic_id ON tasks(topic_id);`);
const now = () => new Date().toISOString(); const id = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
export class TopicService {
  list() { return db.prepare('SELECT id,name,description,is_exploration as isExploration,created_at as createdAt,updated_at as updatedAt FROM topics ORDER BY updated_at DESC').all(); }
  get(topicId: string) { const topic = db.prepare('SELECT id,name,description,is_exploration as isExploration,created_at as createdAt,updated_at as updatedAt FROM topics WHERE id=?').get(topicId); if (!topic) return null; return { ...topic, tasks: db.prepare('SELECT id,topic_id as topicId,title,description,status,result_summary as resultSummary,created_at as createdAt,updated_at as updatedAt FROM tasks WHERE topic_id=? ORDER BY updated_at DESC').all(topicId) }; }
  create(input: { name: string; description?: string; isExploration?: boolean }) { const timestamp = now(); const topicId = id(); db.prepare('INSERT INTO topics (id,name,description,is_exploration,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(topicId, input.name, input.description ?? '', input.isExploration ? 1 : 0, timestamp, timestamp); return this.get(topicId); }
  update(topicId: string, input: Partial<{ name: string; description: string; isExploration: boolean }>) { if (!this.get(topicId)) throw Object.assign(new Error('主题不存在'), { status: 404 }); const current = db.prepare('SELECT name,description,is_exploration as isExploration FROM topics WHERE id=?').get(topicId) as any; db.prepare('UPDATE topics SET name=?,description=?,is_exploration=?,updated_at=? WHERE id=?').run(input.name ?? current.name, input.description ?? current.description, input.isExploration === undefined ? current.isExploration : input.isExploration ? 1 : 0, now(), topicId); return this.get(topicId); }
  remove(topicId: string) { if (!this.get(topicId)) throw Object.assign(new Error('主题不存在'), { status: 404 }); const count = (db.prepare('SELECT COUNT(*) as count FROM tasks WHERE topic_id=?').get(topicId) as any).count; if (count) throw Object.assign(new Error('非空主题不能删除'), { status: 409 }); db.prepare('DELETE FROM topics WHERE id=?').run(topicId); return { id: topicId }; }
}
export class TaskService {
  list(topicId?: string) { return db.prepare(`SELECT id,topic_id as topicId,title,description,status,result_summary as resultSummary,created_at as createdAt,updated_at as updatedAt FROM tasks ${topicId ? 'WHERE topic_id=?' : ''} ORDER BY updated_at DESC`).all(...(topicId ? [topicId] : [])); }
  get(taskId: string) { return db.prepare('SELECT id,topic_id as topicId,title,description,status,result_summary as resultSummary,created_at as createdAt,updated_at as updatedAt FROM tasks WHERE id=?').get(taskId) ?? null; }
  create(input: { topicId: string; title: string; description?: string; status?: TaskStatus; resultSummary?: string }) { if (!new TopicService().get(input.topicId)) throw Object.assign(new Error('主题不存在'), { status: 404 }); const timestamp = now(); const taskId = id(); db.prepare('INSERT INTO tasks (id,topic_id,title,description,status,result_summary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(taskId, input.topicId, input.title, input.description ?? '', input.status ?? 'todo', input.resultSummary ?? '', timestamp, timestamp); return this.get(taskId); }
  update(taskId: string, input: Partial<{ title: string; description: string; status: TaskStatus; resultSummary: string; topicId: string }>) { const current = this.get(taskId) as any; if (!current) throw Object.assign(new Error('任务不存在'), { status: 404 }); if (input.topicId && !new TopicService().get(input.topicId)) throw Object.assign(new Error('主题不存在'), { status: 404 }); db.prepare('UPDATE tasks SET topic_id=?,title=?,description=?,status=?,result_summary=?,updated_at=? WHERE id=?').run(input.topicId ?? current.topicId, input.title ?? current.title, input.description ?? current.description, input.status ?? current.status, input.resultSummary ?? current.resultSummary, now(), taskId); return this.get(taskId); }
  remove(taskId: string) { if (!this.get(taskId)) throw Object.assign(new Error('任务不存在'), { status: 404 }); db.prepare('DELETE FROM tasks WHERE id=?').run(taskId); return { id: taskId }; }
}
