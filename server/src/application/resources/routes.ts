import { Router } from 'express';
import { z } from 'zod';
import { getActor } from '../security.js';
import { ResourceService } from './service.js';

export function createResourceRouter(service = new ResourceService()) {
  const router = Router();
  router.get('/receipts/:requestId', async (req, res, next) => { try { res.json({ data: await service.receipt(getActor(req), String(req.params.requestId)), error: null }); } catch (error) { next(error); } });
  router.post('/', async (req, res, next) => { try { res.json({ data: await service.create(getActor(req), req.body), error: null }); } catch (error) { next(error); } });
  router.get('/:id', async (req, res, next) => { try { const revision = req.query.revision === undefined ? undefined : z.coerce.number().int().positive().parse(req.query.revision); res.json({ data: await service.read(getActor(req), String(req.params.id), revision), error: null }); } catch (error) { next(error); } });
  router.put('/:id/content', async (req, res, next) => { try { res.json({ data: await service.save(getActor(req), String(req.params.id), req.body), error: null }); } catch (error) { next(error); } });
  router.post('/:id/restore', async (req, res, next) => { try { res.json({ data: await service.restore(getActor(req), String(req.params.id), req.body), error: null }); } catch (error) { next(error); } });
  router.patch('/:id/organization', async (req, res, next) => { try { res.json({ data: await service.organize(getActor(req), String(req.params.id), req.body), error: null }); } catch (error) { next(error); } });
  router.get('/:id/impact', async (req, res, next) => { try { res.json({ data: await service.impact(getActor(req), String(req.params.id)), error: null }); } catch (error) { next(error); } });
  router.get('/:id/versions/:revision/:operation', async (req, res, next) => {
    if (!['original', 'source-original'].includes(String(req.params.operation))) { next(); return; }
    try {
      const result = await service.original(getActor(req), String(req.params.id), z.coerce.number().int().positive().parse(req.params.revision), req.params.operation === 'source-original');
      res.set({ 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'X-Dovun-Mime-Type': result.mimeType.replace(/[^\x20-\x7e]/g, ''), 'Content-Disposition': `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(result.fileName)}` }).send(result.bytes);
    } catch (error) { next(error); }
  });
  return router;
}
