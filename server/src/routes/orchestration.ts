import { Router, type Request, type Response, type NextFunction } from 'express';
import { NodeService, getNode, nodeMiddleware } from '../application/orchestration/nodes.js';
import { ProjectService } from '../application/orchestration/projects.js';
import { OrchestrationService } from '../application/orchestration/service.js';
import { isServerMode, publicWorkspaceUrl } from '../application/desktop-paths.js';

const route = (action: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => { try { res.json({ data: await action(req), error: null }); } catch (error) { next(error); } };
const nodes = new NodeService();
const projects = new ProjectService();
const orchestrations = new OrchestrationService();

function serverUrl(req: Request) {
  if (isServerMode() && publicWorkspaceUrl()) return publicWorkspaceUrl();
  return `${req.protocol}://${req.get('host') ?? '127.0.0.1:3016'}`;
}

/** Owner-only: mounted after identity + owner middleware. External connections and MCP cannot reach these. */
export function createOrchestrationRouter() {
  const router = Router();
  router.get('/nodes', route(() => nodes.list()));
  router.post('/nodes', route((req) => nodes.create(req.body, serverUrl(req))));
  router.post('/nodes/:id/revoke', route((req) => nodes.revoke(String(req.params.id))));
  router.get('/projects', route(() => projects.list()));
  router.post('/projects', route((req) => projects.create(req.body)));
  router.get('/projects/:id', route((req) => projects.get(String(req.params.id))));
  router.patch('/projects/:id', route((req) => projects.update(String(req.params.id), req.body)));
  router.post('/projects/:id/locations', route((req) => projects.addLocation(String(req.params.id), req.body)));
  router.delete('/projects/:id/locations/:locationId', route((req) => projects.removeLocation(String(req.params.id), String(req.params.locationId))));
  router.get('/project-bindings/:scopeType/:scopeId', route((req) => projects.bindings(String(req.params.scopeType), String(req.params.scopeId))));
  router.put('/project-bindings/:scopeType/:scopeId', route((req) => projects.bind(String(req.params.scopeType), String(req.params.scopeId), req.body)));
  router.post('/orchestrations/preview', route((req) => orchestrations.preview(req.body)));
  router.get('/orchestrations', route((req) => orchestrations.list(typeof req.query.taskId === 'string' ? req.query.taskId : undefined)));
  router.get('/orchestrations/attention', route(() => orchestrations.attention()));
  router.get('/orchestrations/:id', route((req) => orchestrations.get(String(req.params.id))));
  router.post('/orchestrations/:id/start', route((req) => orchestrations.start(String(req.params.id), req.body)));
  router.post('/orchestrations/:id/pause', route((req) => orchestrations.pause(String(req.params.id))));
  router.post('/orchestrations/:id/resume', route((req) => orchestrations.resume(String(req.params.id))));
  router.post('/orchestrations/:id/cancel', route((req) => orchestrations.cancel(String(req.params.id))));
  router.post('/orchestrations/:id/accept', route((req) => orchestrations.accept(String(req.params.id))));
  router.post('/orchestrations/:id/push', route((req) => orchestrations.push(String(req.params.id))));
  router.post('/orchestrations/:id/redispatch', route((req) => orchestrations.redispatch(String(req.params.id))));
  router.post('/orchestrations/:id/steps/:stepId/retry', route((req) => orchestrations.retryStep(String(req.params.id), String(req.params.stepId), req.body)));
  router.post('/orchestrations/:id/steps/:stepId/skip', route((req) => orchestrations.skipStep(String(req.params.id), String(req.params.stepId), req.body)));
  return router;
}

/** Local executors authenticate with `Authorization: Node <token>`; mounted before the owner/connection identity middleware. */
export function createNodeRouter() {
  const router = Router();
  router.use(nodeMiddleware);
  router.post('/lease', route((req) => nodes.lease(getNode(req), req.body)));
  router.post('/jobs/:id/progress', route((req) => nodes.progress(getNode(req), String(req.params.id), req.body)));
  router.post('/jobs/:id/result', route((req) => nodes.report(getNode(req), String(req.params.id), req.body)));
  return router;
}
