import { Router, type Request } from 'express';
import { z } from 'zod';
import { DomainError } from '../domain/task.js';
import { checkLocalOrigin, requireOwner } from '../application/security.js';
import { publishWorkspaceChange } from '../application/commands.js';
import { assertSchema, currentSyncSeq, findSyncDevice, listBaselineIds, listBaselineRows, listSyncConflicts, offerBaselineRows, pairSyncDevice, pullSyncOps, pushBodySchema, pushSyncOps, resolveSyncConflict } from '../application/sync-log.js';
import { alignBoundReplica, syncStatus, writeSyncBinding } from '../application/sync-replica.js';

async function syncDevice(req: Request) {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) throw new DomainError('AUTH_REQUIRED', '同步设备凭据无效', 401);
  checkLocalOrigin(req);
  const device = await findSyncDevice(authorization.slice(7));
  if (!device) throw new DomainError('AUTH_REQUIRED', '同步设备凭据无效', 401);
  return device;
}

export function createSyncRouter() {
  const router = Router();
  router.post('/devices', async (req, res, next) => {
    try {
      await requireOwner(req);
      const body = z.object({ name: z.string().trim().max(80).optional() }).strict().parse(req.body ?? {});
      res.json({ data: await pairSyncDevice(body.name ?? ''), error: null });
    } catch (error) { next(error); }
  });
  router.post('/push', async (req, res, next) => {
    try {
      const device = await syncDevice(req);
      const body = pushBodySchema.parse(req.body ?? {});
      const data = await pushSyncOps(device.id, body);
      publishWorkspaceChange({ kind: 'sync', syncSeq: data.tip });
      res.json({ data, error: null });
    } catch (error) { next(error); }
  });
  router.get('/pull', async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      if (header) await syncDevice(req);
      else await requireOwner(req);
      const after = z.coerce.number().int().min(0).default(0).parse(req.query.after ?? 0);
      const limit = z.coerce.number().int().min(1).max(500).default(200).parse(req.query.limit ?? 200);
      res.json({ data: await pullSyncOps(after, limit), error: null });
    } catch (error) { next(error); }
  });
  router.get('/conflicts', async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      if (header) await syncDevice(req);
      else await requireOwner(req);
      res.json({ data: await listSyncConflicts(), error: null });
    } catch (error) { next(error); }
  });
  router.post('/conflicts/:id/resolve', async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      const deviceId = header ? (await syncDevice(req)).id : 'server';
      if (!header) await requireOwner(req);
      const body = z.object({ choice: z.enum(['mine', 'theirs']) }).strict().parse(req.body ?? {});
      const data = await resolveSyncConflict(String(req.params.id), body.choice, deviceId);
      publishWorkspaceChange({ kind: 'sync', syncSeq: await currentSyncSeq() });
      res.json({ data, error: null });
    } catch (error) { next(error); }
  });
  router.get('/status', async (req, res, next) => {
    try {
      await requireOwner(req);
      res.json({ data: await syncStatus(), error: null });
    } catch (error) { next(error); }
  });
  router.post('/bind', async (req, res, next) => {
    try {
      await requireOwner(req);
      const body = z.object({ url: z.string().min(1).max(300), token: z.string().min(20).max(200) }).strict().parse(req.body ?? {});
      res.json({ data: writeSyncBinding(body), error: null });
    } catch (error) { next(error); }
  });
  router.post('/align', async (req, res, next) => {
    try {
      await requireOwner(req);
      const data = await alignBoundReplica();
      res.json({ data, error: null });
    } catch (error) { next(error); }
  });
  router.get('/baseline/ids', async (req, res, next) => {
    try {
      await allowSyncRead(req);
      if (typeof req.query.schemaVersion === 'string') assertSchema(req.query.schemaVersion);
      const entity = z.enum(['task', 'topic', 'tag']).parse(req.query.entity);
      const afterId = z.string().max(200).default('').parse(req.query.afterId ?? '');
      const limit = z.coerce.number().int().min(1).max(500).default(200).parse(req.query.limit ?? 200);
      res.json({ data: await listBaselineIds(entity, afterId, limit), error: null });
    } catch (error) { next(error); }
  });
  router.get('/baseline/rows', async (req, res, next) => {
    try {
      await allowSyncRead(req);
      if (typeof req.query.schemaVersion === 'string') assertSchema(req.query.schemaVersion);
      const entity = z.enum(['task', 'topic', 'tag']).parse(req.query.entity);
      const afterId = z.string().max(200).default('').parse(req.query.afterId ?? '');
      const limit = z.coerce.number().int().min(1).max(50).default(50).parse(req.query.limit ?? 50);
      res.json({ data: await listBaselineRows(entity, afterId, limit), error: null });
    } catch (error) { next(error); }
  });
  router.post('/baseline/offer', async (req, res, next) => {
    try {
      const device = await syncDevice(req);
      const body = z.object({
        schemaVersion: z.string().min(1),
        entityType: z.enum(['task', 'topic', 'tag']),
        rows: z.array(z.object({ id: z.string().min(1).max(200), row: z.record(z.unknown()) }).strict()).min(1).max(40),
      }).strict().parse(req.body ?? {});
      const data = await offerBaselineRows(device.id, body.schemaVersion, body.entityType, body.rows);
      publishWorkspaceChange({ kind: 'sync', syncSeq: data.tip });
      res.json({ data, error: null });
    } catch (error) { next(error); }
  });
  return router;
}

async function allowSyncRead(req: Request) {
  if (req.headers.authorization) await syncDevice(req);
  else await requireOwner(req);
}
