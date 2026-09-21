import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { prisma } from '../infrastructure/prisma.js';
import { ControlledExecutionAdapter } from '../infrastructure/controlled-execution.js';
import { CommandService, type Command } from '../application/commands.js';
import { assertOwner, getActor } from '../application/security.js';
import { KnowledgeService, knowledgeFailure } from '../application/knowledge.js';
import { OrganizationService } from '../application/knowledge-organizations.js';

const topic = (value: unknown) => typeof value === 'string' && value && value !== 'inbox' && value !== 'null' ? value : null;
const pagination = (query: Record<string, unknown>) => z.object({ cursor: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).parse(query);
const requestId = (req: Request) => typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : randomUUID();

export function createKnowledgeRouter(service = new KnowledgeService(), organizations = new OrganizationService()) {
  const router = Router();
  router.get('/materials', async (req, res, next) => { try { res.json({ data: await service.materials(getActor(req), topic(req.query.topicId), { ...pagination(req.query), taskId: typeof req.query.taskId === 'string' ? req.query.taskId : undefined, includeArchived: req.query.includeArchived === 'true' }), error: null }); } catch (error) { next(error); } });
  router.get('/materials/:id', async (req, res, next) => { try { res.json({ data: await service.material(getActor(req), String(req.params.id)), error: null }); } catch (error) { next(error); } });
  router.get('/materials/:id/versions/:revision/attachment', async (req, res, next) => {
    try {
      const result = await service.attachment(getActor(req), String(req.params.id), z.coerce.number().int().positive().parse(req.params.revision));
      res.set({ 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(result.fileName)}` }).send(result.bytes);
    } catch (error) { next(error); }
  });
  const submit = async (req: Request, command: Command) => new CommandService().submit(getActor(req), { requestId: requestId(req), commands: [command] });
  router.post('/materials', async (req, res, next) => { try { res.json({ data: await submit(req, { kind: 'material.create', input: req.body }), error: null }); } catch (error) { next(error); } });
  router.post('/materials/:id/versions', async (req, res, next) => { try { const { expectedVersion, ...input } = req.body; res.json({ data: await submit(req, { kind: 'material.update', targetId: String(req.params.id), expectedRevision: expectedVersion, input }), error: null }); } catch (error) { next(error); } });
  router.patch('/materials/:id', async (req, res, next) => { try { const { expectedVersion, ...input } = req.body; res.json({ data: await submit(req, { kind: 'material.archive', targetId: String(req.params.id), expectedRevision: expectedVersion, input }), error: null }); } catch (error) { next(error); } });
  router.post('/materials/:id/fetch', async (req, res, next) => {
    try {
      const actor = getActor(req);
      assertOwner(actor);
      const { expectedVersion } = z.object({ expectedVersion: z.number().int().positive() }).parse(req.body);
      const material = await service.material(actor, String(req.params.id));
      if (material.revision !== expectedVersion) throw knowledgeFailure('VERSION_CONFLICT', '链接材料已变化，请刷新');
      if (material.kind !== 'link' || !material.uri) throw knowledgeFailure('NOT_A_LINK', '仅链接材料可以抓取网页', 400);
      const result = await new ControlledExecutionAdapter().execute({ kind: 'http', input: { url: material.uri, method: 'GET' }, approvalId: `material-fetch:${material.id}`, timeoutMs: 15_000, maxOutputBytes: 256 * 1024 });
      if (!result.success) throw knowledgeFailure(result.errorCode ?? 'FETCH_FAILED', result.error ?? '链接抓取失败', 502);
      const response = result.data as { status: number; body: string };
      if (response.status < 200 || response.status >= 300) throw knowledgeFailure('FETCH_HTTP_ERROR', `链接返回 HTTP ${response.status}`, 502);
      res.json({ data: await submit(req, { kind: 'material.update', targetId: material.id, expectedRevision: expectedVersion, input: { content: response.body, metadata: { ...material.versions[0]?.metadata, capturedAt: new Date().toISOString(), capturePolicy: 'controlled_http_redacted', url: material.uri } } }), error: null });
    } catch (error) { next(error); }
  });
  router.post('/materials/from-conversation', async (req, res, next) => {
    try {
      const actor = getActor(req); assertOwner(actor);
      const input = z.object({ conversationId: z.string().min(1), topicId: z.string().nullable().default(null), title: z.string().trim().min(1), messageIds: z.array(z.string()).optional() }).parse(req.body);
      const conversation = await prisma.conversation.findUnique({ where: { id: input.conversationId }, include: { messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
      if (!conversation) throw knowledgeFailure('NOT_FOUND', '会话不存在', 404);
      const selected = input.messageIds ? conversation.messages.filter((row) => input.messageIds!.includes(row.id)) : conversation.messages;
      if (input.messageIds && selected.length !== new Set(input.messageIds).size) throw knowledgeFailure('INVALID_MESSAGES', '选择的消息不属于该会话', 400);
      res.json({ data: await submit(req, { kind: 'material.create', input: { topicId: input.topicId, kind: 'thread', title: input.title, content: selected.map((row) => `## ${row.role}\n\n${row.content}`).join('\n\n'), metadata: { provider: 'builtin', sessionId: input.conversationId, messageIds: selected.map((row) => row.id), completeness: input.messageIds ? 'excerpt' : 'full' } } }), error: null });
    } catch (error) { next(error); }
  });
  router.get('/memories', async (req, res, next) => { try { res.json({ data: await service.memories(getActor(req), topic(req.query.topicId), { ...pagination(req.query), history: req.query.history === 'true' }), error: null }); } catch (error) { next(error); } });
  router.get('/memories/:id', async (req, res, next) => { try { res.json({ data: await service.memory(getActor(req), String(req.params.id)), error: null }); } catch (error) { next(error); } });
  router.post('/memories', async (req, res, next) => { try { res.json({ data: await submit(req, { kind: 'memory.create', input: req.body }), error: null }); } catch (error) { next(error); } });
  router.patch('/memories/:id', async (req, res, next) => { try { const { expectedVersion, ...input } = req.body; res.json({ data: await submit(req, { kind: 'memory.update', targetId: String(req.params.id), expectedRevision: expectedVersion, input }), error: null }); } catch (error) { next(error); } });
  router.get('/brief', async (req, res, next) => { try { res.json({ data: await service.brief(getActor(req), topic(req.query.topicId)), error: null }); } catch (error) { next(error); } });
  router.put('/brief', async (req, res, next) => { try { res.json({ data: await service.saveBrief(getActor(req), { ...req.body, topicId: topic(req.body.topicId) }), error: null }); } catch (error) { next(error); } });
  router.get('/search', async (req, res, next) => { try { res.json({ data: await service.search(getActor(req), { ...pagination(req.query), topicId: topic(req.query.topicId), q: String(req.query.q ?? ''), includeHistory: req.query.includeHistory === 'true' }), error: null }); } catch (error) { next(error); } });
  router.get('/organizations', async (req, res, next) => { try { res.json({ data: await organizations.list(getActor(req), topic(req.query.topicId)), error: null }); } catch (error) { next(error); } });
  router.post('/organizations', async (req, res, next) => { try { res.json({ data: await organizations.create(getActor(req), req.body), error: null }); } catch (error) { next(error); } });
  router.get('/organizations/:id', async (req, res, next) => { try { res.json({ data: await organizations.get(getActor(req), String(req.params.id)), error: null }); } catch (error) { next(error); } });
  router.post('/organizations/:id/generate', async (req, res, next) => { try { res.json({ data: await organizations.generate(getActor(req), String(req.params.id)), error: null }); } catch (error) { next(error); } });
  router.post('/organizations/:id/candidates', async (req, res, next) => { try { res.json({ data: await organizations.submitCandidates(getActor(req), String(req.params.id), req.body), error: null }); } catch (error) { next(error); } });
  router.get('/export', async (req, res, next) => {
    try {
      const actor = getActor(req); const topicId = topic(req.query.topicId);
      const materials = []; let materialCursor: number | null = 0;
      let totalAttachmentBytes = 0;
      while (materialCursor !== null) {
        const page = await service.materials(actor, topicId, { includeArchived: true, cursor: materialCursor, limit: 100 });
        for (const row of page.items) {
          const material = await service.material(actor, row.id);
          const versions = [];
          for (const version of material.versions) {
            if (!version.hasAttachment) { versions.push(version); continue; }
            const attachment = await service.attachment(actor, row.id, version.revision);
            totalAttachmentBytes += attachment.bytes.byteLength;
            if (totalAttachmentBytes > 64 * 1024 * 1024) throw knowledgeFailure('EXPORT_TOO_LARGE', '附件合计超过 64 MiB，请逐个版本下载原件', 413);
            versions.push({ ...version, attachmentBase64: attachment.bytes.toString('base64') });
          }
          materials.push({ ...material, versions });
        }
        materialCursor = page.nextCursor;
      }
      const memories = []; let memoryCursor: number | null = 0;
      while (memoryCursor !== null) { const page = await service.memories(actor, topicId, { history: true, cursor: memoryCursor, limit: 100 }); for (const row of page.items) memories.push(await service.memory(actor, row.id)); memoryCursor = page.nextCursor; }
      const brief = await prisma.workingBrief.findUnique({ where: { id: topicId ? `topic:${topicId}` : 'inbox' } });
      const bundle = { format: 'work-with-agent-knowledge-v1', topicId, exportedAt: new Date().toISOString(), materials, memories, manualNotes: brief?.manualNotes ?? '' };
      res.set({ 'Content-Disposition': 'attachment; filename="project-knowledge.json"', 'Content-Type': 'application/json; charset=utf-8' }).send(JSON.stringify(bundle, null, 2));
    } catch (error) { next(error); }
  });
  return router;
}
