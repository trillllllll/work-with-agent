import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { SettingsService } from './application/settings.js';
import { TopicService, TaskService, TagService, ChangeService } from './application/workspace.js';
import { AgentService } from './agent.js';
import { securityRouter, connectionRouter, identityMiddleware, ownerMiddleware, corsOptions } from './application/security.js';
import { commandsRouter } from './application/commands.js';
import { legacyMutationMiddleware, workspaceQueryRouter } from './application/workspace-api.js';
import { handoffRouter } from './routes/handoffs.js';
import { createKnowledgeRouter } from './routes/knowledge.js';
import { createReviewsRouter } from './routes/reviews.js';
import { registerKnowledgeCommands } from './application/knowledge.js';
import { ReviewService } from './application/reviews.js';
import { OrganizationService } from './application/knowledge-organizations.js';
import { generateExternalReview } from './runner/review-generator.js';

export const app = express();
app.use(cors(corsOptions));
app.use(express.json({ limit: '12mb' }));
registerKnowledgeCommands();
app.use('/api/v1', securityRouter);
app.use('/api/v1', identityMiddleware);
app.use('/api/v1/connections', connectionRouter);
app.use('/api/v1', commandsRouter, workspaceQueryRouter, handoffRouter);
app.use('/api/v1/knowledge', createKnowledgeRouter());
export const reviewService = new ReviewService(new OrganizationService(), generateExternalReview);
app.use('/api/v1/reviews', createReviewsRouter(reviewService));
// Existing browser endpoints remain available only to authenticated owner sessions.
app.use('/api', identityMiddleware, ownerMiddleware, legacyMutationMiddleware);

const topics = new TopicService();
const tasks = new TaskService();
const settings = new SettingsService();
const agent = new AgentService();
const changes = new ChangeService();
const tags = new TagService();
const userContext = (req: Request) => ({ source: 'user' as const, requestId: typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined });
const send = (res: Response, result: unknown) => {
  if (result && typeof result === 'object' && !Array.isArray(result) && 'meta' in result) {
    const { meta, ...data } = result;
    return res.json({ data, error: null, meta });
  }
  return res.json({ data: result, error: null });
};
const schema = (value: z.ZodTypeAny) => (req: Request, res: Response, next: NextFunction) => {
  const parsed = value.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ data: null, error: parsed.error.flatten() });
  req.body = parsed.data;
  return next();
};

app.get('/api/topics', async (req, res, next) => { try { send(res, await topics.list({ archived: req.query.archived === 'true' })); } catch (error) { next(error); } });
app.get('/api/topics/:id', async (req, res, next) => {
  try { const topic = await topics.get(String(req.params.id), { includeArchived: req.query.includeArchived === 'true' }); if (!topic) return res.status(404).json({ data: null, error: '清单不存在' }); send(res, topic); } catch (error) { next(error); }
});
app.post('/api/topics', async (req, res, next) => { try { send(res, await topics.create(req.body, userContext(req))); } catch (error) { next(error); } });
app.patch('/api/topics/:id', async (req, res, next) => { try { send(res, await topics.update(String(req.params.id), req.body, userContext(req))); } catch (error) { next(error); } });
app.post('/api/topics/:id/summary/generate', schema(z.object({ summary: z.string().trim().min(1) })), async (req, res, next) => { try { send(res, await topics.generateSummary(String(req.params.id), req.body.summary, userContext(req))); } catch (error) { next(error); } });
app.post('/api/topics/:id/summary/confirm', async (req, res, next) => { try { send(res, await topics.confirmSummary(String(req.params.id), userContext(req))); } catch (error) { next(error); } });
app.post('/api/topics/:id/summary/discard', async (req, res, next) => { try { send(res, await topics.discardSummary(String(req.params.id), userContext(req))); } catch (error) { next(error); } });
// Legacy endpoint: archives the topic AND moves its tasks into Inbox.
app.delete('/api/topics/:id', async (req, res, next) => { try { send(res, await topics.remove(String(req.params.id), userContext(req))); } catch (error) { next(error); } });
app.post('/api/topics/:id/archive', async (req, res, next) => { try { send(res, await topics.archive(String(req.params.id), userContext(req))); } catch (error) { next(error); } });
app.post('/api/topics/:id/restore', async (req, res, next) => { try { send(res, await topics.restore(String(req.params.id), userContext(req))); } catch (error) { next(error); } });
app.post('/api/topics/:id/move-tasks-to-inbox', async (req, res, next) => { try { send(res, await topics.moveTasksToInbox(String(req.params.id), userContext(req))); } catch (error) { next(error); } });

const taskQuery = z.object({
  topicId: z.string().min(1).optional(),
  inbox: z.enum(['true', 'false']).optional(),
  q: z.string().optional(),
  status: z.enum(['open', 'done', 'all', 'todo', 'doing', 'blocked']).optional(),
  dueFrom: z.string().optional(),
  dueTo: z.string().optional(),
  tagIds: z.string().optional(),
  sort: z.enum(['manual', 'date', 'priority']).optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
  parentId: z.string().optional(),
});
app.get('/api/tasks', async (req, res, next) => {
  try {
    const query = taskQuery.parse(req.query);
    send(res, await tasks.list(query.topicId, {
      inbox: query.inbox === 'true', q: query.q, status: query.status,
      dueFrom: query.dueFrom, dueTo: query.dueTo,
      tagIds: query.tagIds?.split(',').filter(Boolean), sort: query.sort,
      includeArchived: query.includeArchived === 'true',
      ...(query.parentId !== undefined ? { parentId: query.parentId === 'null' ? null : query.parentId } : {}),
    }));
  } catch (error) { next(error); }
});
app.post('/api/tasks/reorder', async (req, res, next) => { try { send(res, await tasks.reorder(req.body, userContext(req))); } catch (error) { next(error); } });
app.get('/api/tasks/:id', async (req, res, next) => { try { const task = await tasks.get(String(req.params.id)); if (!task) return res.status(404).json({ data: null, error: '任务不存在' }); send(res, task); } catch (error) { next(error); } });
app.get('/api/tasks/:id/topic-history', async (req, res, next) => { try { send(res, await tasks.topicHistory(String(req.params.id))); } catch (error) { next(error); } });
app.post('/api/tasks', async (req, res, next) => { try { send(res, await tasks.create(req.body, userContext(req))); } catch (error) { next(error); } });
app.patch('/api/tasks/:id', async (req, res, next) => { try { send(res, await tasks.update(String(req.params.id), req.body, userContext(req))); } catch (error) { next(error); } });
app.delete('/api/tasks/:id', async (req, res, next) => { try { send(res, await tasks.remove(String(req.params.id), userContext(req))); } catch (error) { next(error); } });
app.get('/api/trash/tasks', async (_req, res, next) => { try { send(res, await tasks.listDeleted()); } catch (error) { next(error); } });
app.post('/api/trash/tasks/:id/restore', async (req, res, next) => { try { send(res, await tasks.restore(String(req.params.id), userContext(req))); } catch (error) { next(error); } });
app.delete('/api/trash/tasks/:id/permanent', async (req, res, next) => { try { send(res, await tasks.permanentDelete(String(req.params.id), userContext(req))); } catch (error) { next(error); } });
app.get('/api/tags', async (_req, res, next) => { try { send(res, await tags.list()); } catch (error) { next(error); } });
app.post('/api/tags', async (req, res, next) => { try { send(res, await tags.create(req.body, userContext(req))); } catch (error) { next(error); } });
app.patch('/api/tags/:id', async (req, res, next) => { try { send(res, await tags.update(String(req.params.id), req.body, userContext(req))); } catch (error) { next(error); } });
app.delete('/api/tags/:id', async (req, res, next) => { try { send(res, await tags.remove(String(req.params.id), userContext(req))); } catch (error) { next(error); } });

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
app.post('/api/agent/approvals/:id/preview', async (req, res, next) => { try { send(res, await agent.previewApproval(String(req.params.id))); } catch (error) { next(error); } });
app.post('/api/agent/approvals/:id/reject', async (req, res, next) => { try { send(res, await agent.reject(String(req.params.id))); } catch (error) { next(error); } });
app.get('/api/changes', async (req, res, next) => { try { send(res, await changes.list(typeof req.query.entityType === 'string' ? req.query.entityType : undefined, typeof req.query.entityId === 'string' ? req.query.entityId : undefined)); } catch (error) { next(error); } });
app.post('/api/changes/:id/undo', async (req, res, next) => { try { send(res, await changes.undo(String(req.params.id), userContext(req))); } catch (error) { next(error); } });

app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  if (error instanceof z.ZodError) return res.status(400).json({ data: null, error: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '), code: 'VALIDATION_ERROR' });
  const status = Number(error?.status) || 500;
  res.status(status).json({ data: null, error: error?.message ?? '服务器错误', ...(error?.code ? { code: error.code } : {}), ...(error?.details ? { details: error.details } : {}) });
});
