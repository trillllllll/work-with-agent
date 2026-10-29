import { Router, type Request } from 'express';
import { z } from 'zod';
import { getActor } from '../application/security.js';
import { LibraryService } from '../application/library/service.js';
import { libraryFiltersSchema } from '../application/library/schema.js';
import { askLibrary } from '../application/library/ask.js';
import { beginReceive, cancelUpload, failReceive, finishReceive, openUpload, readOwnUpload, uploadByteLimit, writeUploadBody } from '../application/library/uploads.js';
import { libraryError } from '../application/library/access.js';
import { createResourceRouter } from '../application/resources/routes.js';

const page = z.object({ cursor: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(40) });

function list(value: unknown) {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value.flatMap((item) => String(item).split(',')) : String(value).split(',');
  const items = raw.map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function filtersOf(query: Request['query']) {
  return libraryFiltersSchema.parse({
    folderId: typeof query.folderId === 'string' ? query.folderId : undefined,
    recursive: query.recursive === undefined ? undefined : query.recursive !== 'false',
    tagIds: list(query.tagIds),
    taskId: typeof query.taskId === 'string' ? query.taskId : undefined,
    taskTopicId: typeof query.taskTopicId === 'string' ? query.taskTopicId : undefined,
    kind: typeof query.kind === 'string' ? query.kind : undefined,
    archived: typeof query.archived === 'string' ? query.archived : undefined,
    view: typeof query.view === 'string' ? query.view : undefined,
  });
}

export function createLibraryRouter(service = new LibraryService()) {
  const router = Router();
  router.use('/resources', createResourceRouter());
  router.get('/materials', async (req, res, next) => {
    try {
      const paging = page.parse(req.query);
      res.json({ data: await service.materials(getActor(req), filtersOf(req.query), paging.cursor, paging.limit), error: null });
    } catch (error) { next(error); }
  });
  router.get('/materials/:id', async (req, res, next) => { try { res.json({ data: await service.material(getActor(req), String(req.params.id)), error: null }); } catch (error) { next(error); } });
  router.get('/materials/:id/tasks', async (req, res, next) => {
    try { const paging = page.parse(req.query); res.json({ data: await service.materialTasks(getActor(req), String(req.params.id), paging.cursor, paging.limit), error: null }); } catch (error) { next(error); }
  });
  router.get('/tasks/:id/materials', async (req, res, next) => {
    try {
      const paging = page.parse(req.query);
      const archived = typeof req.query.archived === 'string' ? z.enum(['exclude', 'only', 'include']).parse(req.query.archived) : undefined;
      res.json({ data: await service.taskMaterials(getActor(req), String(req.params.id), { archived }, paging.cursor, paging.limit), error: null });
    } catch (error) { next(error); }
  });
  router.get('/materials/:id/content', async (req, res, next) => {
    try {
      const paging = page.parse(req.query);
      const revision = z.coerce.number().int().positive().parse(req.query.revision);
      res.json({ data: await service.content(getActor(req), String(req.params.id), revision, paging.cursor, paging.limit), error: null });
    } catch (error) { next(error); }
  });
  router.get('/chunks/:id', async (req, res, next) => { try { res.json({ data: await service.chunk(getActor(req), String(req.params.id)), error: null }); } catch (error) { next(error); } });
  router.get('/materials/:id/versions/:revision/source', async (req, res, next) => {
    try {
      const source = await service.source(getActor(req), String(req.params.id), z.coerce.number().int().positive().parse(req.params.revision));
      if (source.kind === 'text') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('X-Dovun-Content-Format', source.format);
        res.setHeader('X-Dovun-Read-Only-Projection', String(source.readOnlyProjection));
        res.send(source.content);
        return;
      }
      res.json({ data: source, error: null });
    } catch (error) { next(error); }
  });
  router.get('/folders', async (req, res, next) => { try { res.json({ data: await service.folders(getActor(req)), error: null }); } catch (error) { next(error); } });
  router.get('/tags', async (req, res, next) => { try { res.json({ data: await service.tags(getActor(req)), error: null }); } catch (error) { next(error); } });
  router.get('/search', async (req, res, next) => {
    try {
      const paging = page.parse(req.query);
      res.json({ data: await service.search(getActor(req), String(req.query.q ?? ''), filtersOf(req.query), paging.cursor, paging.limit, req.query.history === 'true'), error: null });
    } catch (error) { next(error); }
  });
  router.get('/answers/:id', async (req, res, next) => { try { res.json({ data: await service.answer(getActor(req), String(req.params.id)), error: null }); } catch (error) { next(error); } });
  router.post('/answers', async (req, res, next) => {
    try {
      const body = z.object({ requestKey: z.string().min(1), question: z.string(), filters: libraryFiltersSchema.default({}) }).parse(req.body);
      res.json({ data: await askLibrary(getActor(req), body.requestKey, body.question, body.filters), error: null });
    } catch (error) { next(error); }
  });
  router.post('/uploads', async (req, res, next) => {
    try {
      const body = z.object({ requestKey: z.string(), fileName: z.string(), mimeType: z.string(), size: z.number() }).parse(req.body);
      const upload = await openUpload(getActor(req), body);
      res.json({ data: { id: upload.id, state: upload.state, maxBytes: uploadByteLimit }, error: null });
    } catch (error) { next(error); }
  });
  router.get('/uploads/:id', async (req, res, next) => {
    try { const upload = await readOwnUpload(getActor(req), String(req.params.id)); res.json({ data: upload, error: null }); } catch (error) { next(error); }
  });
  router.put('/uploads/:id/content', async (req, res, next) => {
    try {
      if (req.headers['content-type']?.split(';')[0] !== 'application/octet-stream') throw libraryError('VALIDATION_ERROR', '请以原始字节上传', 400);
      const actor = getActor(req);
      const started = await beginReceive(actor, String(req.params.id));
      if (started.already) {
        const duplicates = started.upload.sha256 ? await service.duplicates(actor, started.upload.sha256) : [];
        res.json({ data: { id: started.upload.id, state: 'ready', sha256: started.upload.sha256, actualSize: started.upload.actualSize, duplicates }, error: null });
        return;
      }
      if (!started.receipt) throw libraryError('UPLOAD_INTERRUPTED', '上传接收没有开始');
      try {
        const body = await writeUploadBody(started.receipt, started.upload.declaredSize, req);
        const ready = await finishReceive(actor, started.receipt, body);
        const duplicates = ready.sha256 ? await service.duplicates(actor, ready.sha256) : [];
        res.json({ data: { id: ready.id, state: 'ready', sha256: ready.sha256, actualSize: ready.actualSize, duplicates }, error: null });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== 'UPLOAD_SIZE_MISMATCH' && code !== 'UPLOAD_TOO_LARGE' && code !== 'UPLOAD_STALE_ATTEMPT' && code !== 'UPLOAD_CANCELLED') await failReceive(started.receipt.uploadId, 'UPLOAD_INTERRUPTED', started.receipt.token);
        throw error;
      }
    } catch (error) { next(error); }
  });
  router.delete('/uploads/:id', async (req, res, next) => { try { res.json({ data: await cancelUpload(getActor(req), String(req.params.id)), error: null }); } catch (error) { next(error); } });
  return router;
}
