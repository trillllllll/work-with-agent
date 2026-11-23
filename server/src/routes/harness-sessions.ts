import { Router, type Request, type Response, type NextFunction } from 'express';
import { ownerMiddleware } from '../application/security.js';
import { browseDirectory, selectDirectory } from '../application/harness-directories.js';
import {
  createHarnessSession, indexNativeHarnessThreads, listHarnessSessions, listNativeHarnessThreads, openNativeHarnessThread, queueHarnessCommand,
  readHarnessHistory, readHarnessReceipt, readHarnessSession, readHarnessWorkspaceFiles, subscribeHarness, updateHarnessMetadata,
} from '../application/harness-sessions.js';

const route = (action: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ data: await action(req), error: null }); } catch (error) { next(error); }
};
function cursor(value: string | undefined) {
  const match = /^(\d+):(\d+)$/.exec(value ?? '');
  if (!match) return null;
  const epoch = Number(match[1]), seq = Number(match[2]);
  return Number.isSafeInteger(epoch) && Number.isSafeInteger(seq) ? { epoch, seq } : null;
}

export const harnessSessionsRouter = Router();
harnessSessionsRouter.use('/harness-sessions', ownerMiddleware);
harnessSessionsRouter.get('/harness-sessions', route((req) => listHarnessSessions(req.query)));
harnessSessionsRouter.post('/harness-sessions/directories/browse', route((req) => browseDirectory(req.body)));
harnessSessionsRouter.post('/harness-sessions/directories/select', route((req) => selectDirectory(req.body)));
harnessSessionsRouter.post('/harness-sessions/native', route((req) => listNativeHarnessThreads(req.body)));
harnessSessionsRouter.post('/harness-sessions/native/index', route((req) => indexNativeHarnessThreads(req.body)));
harnessSessionsRouter.post('/harness-sessions/native/open', route((req) => openNativeHarnessThread(req.body)));
harnessSessionsRouter.post('/harness-sessions', route((req) => createHarnessSession(req.body)));
harnessSessionsRouter.get('/harness-sessions/:id', route((req) =>
  readHarnessSession(String(req.params.id), req.query.timeline === '1', req.query.settings === '1', req.query.workspace === '1')));
harnessSessionsRouter.patch('/harness-sessions/:id', route((req) => updateHarnessMetadata(String(req.params.id), req.body)));
harnessSessionsRouter.post('/harness-sessions/:id/history', route((req) => readHarnessHistory(String(req.params.id), req.body)));
harnessSessionsRouter.post('/harness-sessions/:id/files', route((req) => readHarnessWorkspaceFiles(String(req.params.id), req.body)));
harnessSessionsRouter.post('/harness-sessions/:id/commands', route((req) => queueHarnessCommand(String(req.params.id), req.body)));
harnessSessionsRouter.get('/harness-sessions/:id/commands/:commandId', route((req) => readHarnessReceipt(String(req.params.id), String(req.params.commandId))));
harnessSessionsRouter.get('/harness-sessions/:id/events', async (req, res, next) => {
  const id = String(req.params.id);
  try {
    const session = await readHarnessSession(id);
    if (res.destroyed) return;
    res.set({
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const write = (frame: string) => {
      if (res.writableLength > 2_000_000) res.destroy();
      if (!res.destroyed && !res.writableEnded) res.write(frame);
    };
    const after = typeof req.query.after === 'string' ? req.query.after : undefined;
    const stop = subscribeHarness(id, cursor(req.get('Last-Event-ID') ?? after), (event) => {
      const marker = event.type === 'snapshot' || event.type === 'event' ? `id: ${event.epoch}:${event.seq}\n` : '';
      write(`${marker}data: ${JSON.stringify(event)}\n\n`);
    }, req.query.timeline === '1', session.historyAvailable, req.query.settings === '1', req.query.workspace === '1');
    const keepAlive = setInterval(() => write(': heartbeat\n\n'), 15_000);
    res.on('close', () => { stop(); clearInterval(keepAlive); });
  } catch (error) { next(error); }
});
