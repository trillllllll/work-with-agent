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
CREATE INDEX IF NOT EXISTS idx_tasks_topic_id ON tasks(topic_id);
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')), content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, tool_name TEXT NOT NULL, arguments TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','executed','failed')), result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
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

export type ToolResult = { success: boolean; data?: unknown; error?: string };
export type ToolCall = { name: string; arguments: Record<string, unknown> };
const readTools = new Set(['list_topics', 'get_topic', 'list_tasks', 'get_task']);
export class ToolService {
  private topics = new TopicService(); private tasks = new TaskService();
  isReadOnly(name: string) { return readTools.has(name); }
  async execute(call: ToolCall): Promise<ToolResult> {
    try {
      const a = call.arguments;
      switch (call.name) {
        case 'list_topics': return { success: true, data: this.topics.list() };
        case 'get_topic': { const value = this.topics.get(String(a.topicId)); return value ? { success: true, data: value } : { success: false, error: '主题不存在' }; }
        case 'list_tasks': return { success: true, data: this.tasks.list(a.topicId ? String(a.topicId) : undefined) };
        case 'get_task': { const value = this.tasks.get(String(a.taskId)); return value ? { success: true, data: value } : { success: false, error: '任务不存在' }; }
        case 'create_topic': return { success: true, data: this.topics.create({ name: String(a.name), description: a.description ? String(a.description) : undefined, isExploration: Boolean(a.isExploration) }) };
        case 'update_topic': return { success: true, data: this.topics.update(String(a.topicId), { name: a.name ? String(a.name) : undefined, description: a.description ? String(a.description) : undefined, isExploration: a.isExploration === undefined ? undefined : Boolean(a.isExploration) }) };
        case 'create_task': return { success: true, data: this.tasks.create({ topicId: String(a.topicId), title: String(a.title), description: a.description ? String(a.description) : undefined, status: a.status as TaskStatus | undefined, resultSummary: a.resultSummary ? String(a.resultSummary) : undefined }) };
        case 'update_task': return { success: true, data: this.tasks.update(String(a.taskId), { title: a.title ? String(a.title) : undefined, description: a.description ? String(a.description) : undefined, status: a.status as TaskStatus | undefined, resultSummary: a.resultSummary ? String(a.resultSummary) : undefined, topicId: a.topicId ? String(a.topicId) : undefined }) };
        case 'delete_task': return { success: true, data: this.tasks.remove(String(a.taskId)) };
        default: return { success: false, error: `未知 Tool: ${call.name}` };
      }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Tool 执行失败' }; }
  }
}
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
export class ApprovalService {
  create(call: ToolCall) { const timestamp = now(); const approvalId = id(); db.prepare('INSERT INTO approvals (id,tool_name,arguments,status,result,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(approvalId, call.name, JSON.stringify(call.arguments), 'pending', null, timestamp, timestamp); return this.get(approvalId); }
  get(approvalId: string) { const value = db.prepare('SELECT id,tool_name as toolName,arguments,status,result,created_at as createdAt,updated_at as updatedAt FROM approvals WHERE id=?').get(approvalId) as any; return value ? { ...value, arguments: JSON.parse(value.arguments) } : null; }
  update(approvalId: string, status: ApprovalStatus, result?: ToolResult) { db.prepare('UPDATE approvals SET status=?,result=?,updated_at=? WHERE id=?').run(status, result ? JSON.stringify(result) : null, now(), approvalId); return this.get(approvalId); }
}
export class ConversationService {
  create() { const timestamp = now(); const conversationId = id(); db.prepare('INSERT INTO conversations (id,created_at,updated_at) VALUES (?,?,?)').run(conversationId, timestamp, timestamp); return conversationId; }
  addMessage(conversationId: string, role: 'user' | 'assistant' | 'tool' | 'system', content: string) { const messageId = id(); const timestamp = now(); db.prepare('INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)').run(messageId, conversationId, role, content, timestamp); db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(timestamp, conversationId); return { id: messageId, conversationId, role, content, createdAt: timestamp }; }
  list(conversationId: string) { return db.prepare('SELECT id,conversation_id as conversationId,role,content,created_at as createdAt FROM messages WHERE conversation_id=? ORDER BY created_at ASC').all(conversationId); }
}
