import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { SettingsService } from './application/settings.js';
import { TopicService, TaskService, ChangeService, WorkspaceMutation } from './application/workspace.js';
import { AgentService } from './agent.js';

export const app = express();
app.use(cors());
app.use(express.json());

const topics = new TopicService();
const tasks = new TaskService();
const settings = new SettingsService();
const agent = new AgentService();
const changes = new ChangeService();
const mutations = new WorkspaceMutation();
const userContext = (req: Request) => ({ source: 'user' as const, requestId: typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined });
const send = (res: Response, data: unknown) => res.json({ data, error: null });
const schema = (value: z.ZodTypeAny) => (req: Request, res: Response, next: NextFunction) => {
  const parsed = value.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ data: null, error: parsed.error.flatten() });
  req.body = parsed.data;
  return next();
};

app.get('/api/topics', async (_, res, next) => { try { send(res, await topics.list()); } catch (error) { next(error); } });
app.get('/api/topics/:id', async (req, res, next) => {
  try { const topic = await topics.get(String(req.params.id)); if (!topic) return res.status(404).json({ data: null, error: '主题不存在' }); send(res, topic); } catch (error) { next(error); }
});
app.post('/api/topics', schema(z.object({ name: z.string().trim().min(1), description: z.string().optional(), isExploration: z.boolean().optional() })), async (req, res, next) => { try { send(res, await mutations.execute({ name: 'create_topic', arguments: req.body }, userContext(req))); } catch (error) { next(error); } });
app.patch('/api/topics/:id', schema(z.object({ name: z.string().trim().min(1).optional(), description: z.string().optional(), isExploration: z.boolean().optional(), goal: z.string().optional(), draftSummary: z.string().optional() })), async (req, res, next) => { try { send(res, await topics.update(String(req.params.id), req.body, userContext(req))); } catch (error) { next(error); } });
app.post('/api/topics/:id/summary/generate', schema(z.object({ summary: z.string().trim().min(1) })), async (req, res, next) => { try { send(res, await topics.generateSummary(String(req.params.id), req.body.summary, userContext(req))); } catch (error) { next(error); } });
app.post('/api/topics/:id/summary/confirm', async (req, res, next) => { try { send(res, await topics.confirmSummary(String(req.params.id), userContext(req))); } catch (error) { next(error); } });
app.post('/api/topics/:id/summary/discard', async (req, res, next) => { try { send(res, await topics.discardSummary(String(req.params.id), userContext(req))); } catch (error) { next(error); } });
app.delete('/api/topics/:id', async (req, res, next) => { try { send(res, await mutations.execute({ name: 'delete_topic', arguments: { topicId: String(req.params.id) } }, userContext(req))); } catch (error) { next(error); } });

app.get('/api/tasks', async (req, res, next) => { try { send(res, await tasks.list(typeof req.query.topicId === 'string' ? req.query.topicId : undefined, { inbox: req.query.inbox === 'true' })); } catch (error) { next(error); } });
app.get('/api/tasks/:id', async (req, res, next) => { try { const task = await tasks.get(String(req.params.id)); if (!task) return res.status(404).json({ data: null, error: '任务不存在' }); send(res, task); } catch (error) { next(error); } });
app.get('/api/tasks/:id/topic-history', async (req, res, next) => { try { send(res, await tasks.topicHistory(String(req.params.id))); } catch (error) { next(error); } });
const taskBody = z.object({ topicId: z.string().trim().min(1).nullable().optional(), title: z.string().trim().min(1), description: z.string().optional(), status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(), priority: z.enum(['none', 'low', 'medium', 'high']).optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), resultSummary: z.string().optional() });
app.post('/api/tasks', schema(taskBody), async (req, res, next) => { try { send(res, await mutations.execute({ name: 'create_task', arguments: req.body }, userContext(req))); } catch (error) { next(error); } });
app.patch('/api/tasks/:id', schema(taskBody.partial()), async (req, res, next) => { try { send(res, await mutations.execute({ name: 'update_task', arguments: { taskId: String(req.params.id), ...req.body } }, userContext(req))); } catch (error) { next(error); } });
app.delete('/api/tasks/:id', async (req, res, next) => { try { send(res, await mutations.execute({ name: 'delete_task', arguments: { taskId: String(req.params.id) } }, userContext(req))); } catch (error) { next(error); } });
app.get('/api/trash/tasks', async (_req, res, next) => { try { send(res, await tasks.listDeleted()); } catch (error) { next(error); } });
app.post('/api/trash/tasks/:id/restore', async (req, res, next) => { try { send(res, await mutations.execute({ name: 'restore_task', arguments: { taskId: String(req.params.id) } }, userContext(req))); } catch (error) { next(error); } });
app.delete('/api/trash/tasks/:id/permanent', async (req, res, next) => { try { send(res, await mutations.execute({ name: 'permanent_delete_task', arguments: { taskId: String(req.params.id) } }, userContext(req))); } catch (error) { next(error); } });

app.get('/api/settings', async (_req, res, next) => { try { send(res, await settings.getPublic()); } catch (error) { next(error); } });
const settingsBody = z.object({ baseUrl: z.string().trim().min(1), model: z.string().trim().min(1), apiKey: z.string().optional() });
app.patch('/api/settings', schema(settingsBody), async (req, res, next) => {
  try { send(res, await settings.save(req.body, (config) => agent.testConnection(config))); } catch (error) { next(error); }
});
app.delete('/api/settings/api-key', async (_req, res, next) => { try { send(res, await settings.clearApiKey()); } catch (error) { next(error); } });

const chatBody = z.object({
  conversationId: z.string().min(1).optional(),
  message: z.string().trim().min(1),
  pageContext: z.object({ topicId: z.string().nullable().optional(), taskId: z.string().nullable().optional(), page: z.string().nullable().optional() }).optional(),
});
const sse = (res: Response, event: string, data: unknown) => {
  if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};
app.post('/api/chat', schema(chatBody), async (req, res) => {
  res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  const controller = new AbortController();
  let closed = false;
  res.on('close', () => { if (!res.writableEnded) { closed = true; controller.abort(); } });
  try {
    for await (const event of agent.chatStream({ ...req.body, signal: controller.signal })) {
      if (closed) return;
      sse(res, event.type, event);
    }
    if (!closed) res.end();
  } catch (error) {
    if (!closed) {
      sse(res, 'error', {
        conversationId: (error as any)?.conversationId ?? req.body.conversationId,
        code: (error as any)?.code ?? 'CHAT_ERROR',
        message: error instanceof Error ? error.message : '聊天失败',
      });
      res.end();
    }
  }
});

app.get('/api/conversations/:id/messages', async (req, res, next) => { try { send(res, await agent.messages(String(req.params.id))); } catch (error) { next(error); } });
app.get('/api/agent/approvals', async (req, res, next) => { try { send(res, await agent.approvalList(typeof req.query.status === 'string' ? req.query.status : undefined)); } catch (error) { next(error); } });
app.post('/api/agent/approvals/:id/approve', async (req, res, next) => { try { send(res, await agent.approve(String(req.params.id))); } catch (error) { next(error); } });
app.post('/api/agent/approvals/:id/reject', async (req, res, next) => { try { send(res, await agent.reject(String(req.params.id))); } catch (error) { next(error); } });
app.get('/api/changes', async (req, res, next) => { try { send(res, await changes.list(typeof req.query.entityType === 'string' ? req.query.entityType : undefined, typeof req.query.entityId === 'string' ? req.query.entityId : undefined)); } catch (error) { next(error); } });
app.post('/api/changes/:id/undo', async (req, res, next) => { try { send(res, await changes.undo(String(req.params.id), userContext(req))); } catch (error) { next(error); } });

app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  const status = Number(error?.status) || 500;
  res.status(status).json({ data: null, error: error?.message ?? '服务器错误', ...(error?.code ? { code: error.code } : {}) });
});
