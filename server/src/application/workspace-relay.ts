import { cliSettings } from '../runner/cli-commands.js';
import { workspaceCachePath as cachePath, cacheAuthorization, cacheIsDenied } from './workspace-cache-access.js';
import type { Request, Response, NextFunction } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError } from '../domain/task.js';
import { prisma } from '../infrastructure/prisma.js';
import { syncDevice } from '../routes/sync.js';
import { connectionConfiguration, requireOwner } from './security.js';
import { desktopDataDir } from './desktop-paths.js';
import { activeSyncBinding, syncBoundReplicaNow, type SyncBinding } from './sync-replica.js';
import { isReplicaRequest, markReplicaRequest } from './replica-identity.js';
import { canonicalSyncRow, isSyncEntityType, syncRowsEqual, type SyncEntityType } from './sync-merge.js';
import { readLive } from './sync-log.js';

const PREFIX = '/api/v1/sync/relay';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const cacheLimit = 24 * 1024 * 1024;
const ownerFamilies = /^\/api\/(?:chat(?:\/|$)|conversations(?:\/|$)|agent(?:\/|$)|orchestrations(?:\/|$)|nodes(?:\/|$)|worktrees(?:\/|$)|worktree-cleanups(?:\/|$)|project-bindings(?:\/|$)|projects(?:\/|$)|skills(?:\/|$)|focus-sessions(?:\/|$)|stats(?:\/|$)|changes(?:\/|$)|plan(?:\/|$)|settings(?:$|\/(?:reply-style|html-blocks|image-search|web-search|api-key)(?:\/|$))|v1\/(?:sync\/archive|assistant\/sources|commands|proposals|knowledge|library|learning|handoffs|runs|runners|artifacts|connections|reviews|plan)(?:\/|$))/;
const taskExtras = /^\/api\/tasks\/[^/]+\/(?:images(?:\/[^/]+)?|ai-history|activity|topic-history)$/;
const scopedFamilies = /^\/api\/v1\/(?:tasks|topics|tags|changes|commands|proposals|knowledge|library|learning|handoffs|runs|runners|artifacts|plan|identity|tools)(?:\/|$)|^\/api\/v1\/trash\/tasks(?:\/|$)/;
const ordinaryTaskCommand = (body: any) => Array.isArray(body?.commands) && body.commands.length > 0 && body.commands.every((command: any) => /^(?:task|topic|tag)\./.test(command.kind) && command.kind !== 'task.reference_materials');
export function relayPathAllowed(path: string) { return ownerFamilies.test(path) || taskExtras.test(path) || /^\/api\/(?:tasks|topics|tags)(?:\/|$)/.test(path); }
const canCache = (path: string) => !/event-stream/.test(path) && /^\/api\/(?:conversations(?:\/|$)|v1\/(?:knowledge|library|artifacts)(?:\/|$)|tasks\/[^/]+\/(?:images\/|activity$|topic-history$|ai-history$))/.test(path);

/** Pairing grants a full workspace replica, never a computer execution credential.
 * Only this allowlisted namespace can authenticate such a device as its owner. */
export async function acceptReplicaRelay(req: Request, _res: Response, next: NextFunction) {
  if (!req.url.startsWith(PREFIX + '/')) { next(); return; }
  try {
    const path = req.url.slice(PREFIX.length);
    if (!relayPathAllowed(new URL(path, 'http://replica').pathname)) throw new DomainError('SCOPE_DENIED', '同步凭据不能访问这个入口', 403);
    await syncDevice(req);
    markReplicaRequest(req);
    req.url = path;
    next();
  } catch (error) { next(error); }
}

async function cloudData(binding: SyncBinding, path: string) {
  const response = await fetch(new URL(PREFIX + path, binding.url), { headers: { authorization: `Bearer ${binding.token}`, ...(binding.workspaceId ? {'x-dovun-workspace-id':binding.workspaceId}:{}), accept: 'application/json' }, signal: AbortSignal.timeout(20_000), redirect: 'error' });
  const body = await response.json();
  if (!response.ok || !body || body.data === undefined) throw new DomainError('SYNC_UNAVAILABLE', '共享工作区暂不可用，本机修改已保留', 502);
  return body.data;
}

async function remapVersions(req: Request, binding: SyncBinding) {
  const body = structuredClone(req.body ?? {}), path = new URL(req.url, 'http://local').pathname;
  const mapRevision = async (entity: SyncEntityType, id: string, expected: unknown) => {
    const local = await prisma.$transaction(tx => readLive(tx, entity, id));
    if (expected !== local.revision) throw new DomainError('VERSION_CONFLICT', '记录已发生变化，请刷新', 409);
    const remote = entity === 'tag' ? (await cloudData(binding, '/api/tags')).find((item: any) => item.id === id) : await cloudData(binding, `/api/${entity === 'task' ? 'tasks' : 'topics'}/${encodeURIComponent(id)}?includeArchived=true`);
    if (!remote || !syncRowsEqual(entity, local.row, canonicalSyncRow(entity, { ...remote, tagIds: remote.tagIds ?? remote.tags?.map((item: any) => item.id) }))) throw new DomainError('VERSION_CONFLICT', '记录已发生变化，请刷新', 409);
    return remote.revision;
  };
  for (const command of body.commands ?? []) {
    const entity = String(command.kind).split('.')[0];
    if (isSyncEntityType(entity) && command.targetId && command.expectedRevision !== undefined) command.expectedRevision = await mapRevision(entity, command.targetId, command.expectedRevision);
  }
  if (body.expectedTaskRevision !== undefined) {
    const match = path.match(/^\/api\/v1\/handoffs\/([^/]+)/);
    const taskId = body.taskId ?? (match ? (await cloudData(binding, `/api/v1/handoffs/${match[1]}`)).taskId : null);
    if (!taskId) throw new DomainError('VERSION_CONFLICT', '记录已发生变化，请刷新', 409);
    body.expectedTaskRevision = await mapRevision('task', taskId, body.expectedTaskRevision);
    for (const [id, revision] of Object.entries(body.expectedChildRevisions ?? {})) body.expectedChildRevisions[id] = await mapRevision('task', id, revision);
  }
  return body;
}

function localTaskChange(record:{entityType:string;beforeSnapshot:string|null;afterSnapshot:string|null}) {
  if (['task','topic','tag'].includes(record.entityType)) return true;
  if (record.entityType !== 'workspace') return false;
  try {return [record.beforeSnapshot,record.afterSnapshot].filter(Boolean).every(raw=>{const row=JSON.parse(raw!);return row.version===2 && row.entities && Object.keys(row.entities).every(key=>['tasks','topics','tags'].includes(key));});} catch{return false;}
}

type CachedResponse = { status: number; type: string; disposition?: string; securityHeaders?: Record<string, string>; body: string };
export async function relayBoundWorkspace(req: Request, res: Response, next: NextFunction) {
  const binding = activeSyncBinding();
  if (!binding || isReplicaRequest(req)) { next(); return; }
  const path = new URL(req.url, 'http://local').pathname;
  const bearer = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ');
  const allowed = bearer ? scopedFamilies.test(path) : ownerFamilies.test(path) || taskExtras.test(path);
  if (!allowed || !bearer && /^\/api\/v1\/commands(?:\/preview)?$/.test(path) && ordinaryTaskCommand(req.body)) { next(); return; }
  // Task undo belongs to the durable local command record; cloud material/AI
  // changes must be undone against the cloud record that created them.
  const undo = path.match(/^\/api\/changes\/([^/]+)\/undo$/);
  if (undo && !bearer) {
    try {
      await requireOwner(req);
      const record = await prisma.changeRecord.findUnique({where:{id:decodeURIComponent(undo[1])}});
      if (record && localTaskChange(record)) {next();return;}
    } catch(error) {next(error);return;}
  }
  let ownerAuthenticated = false;
  try {
    if (!bearer) { await requireOwner(req); ownerAuthenticated = true; }
    const writing = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (writing && !bearer) {
      await syncBoundReplicaNow();
      if (await prisma.syncOutbox.count({ where: { state: 'pending' } })) throw new DomainError('SYNC_PENDING', '请等待本机修改同步完成后重试', 409);
    }
    const headers = new Headers({ authorization: bearer ? req.headers.authorization! : `Bearer ${binding.token}` });
    if (binding.workspaceId) headers.set('x-dovun-workspace-id', binding.workspaceId);
    for (const name of ['content-type', 'accept', 'accept-language', 'x-dovun-language', 'x-request-id', 'last-event-id']) if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name] as string);
    const target = new URL((bearer ? '' : PREFIX) + req.url, binding.url);
    const binaryUpload = req.method === 'PUT' && /^\/api\/v1\/library\/uploads\/[^/]+\/content$/.test(path);
    const payload = writing && !binaryUpload ? bearer ? req.body : await remapVersions(req, binding) : undefined;
    const disconnected = new AbortController();
    res.once('close', () => disconnected.abort());
    const response = await fetch(target, { method: req.method, headers, ...(binaryUpload ? {body:req as unknown as BodyInit,duplex:'half'} : payload !== undefined ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.any([disconnected.signal, AbortSignal.timeout(path === '/api/chat' ? 10 * 60_000 : 30_000)]), redirect: 'error' });
    // A cloud login failure must not invalidate the desktop's local owner session.
    if (response.status === 401 || response.status === 403) {
      if (bearer) { res.status(response.status).json(await response.json()); return; }
      await cacheAuthorization(binding, true).catch(() => {});
      throw new DomainError('SYNC_AUTH_FAILED', '服务器未接受同步凭据，请核对后重试', 502);
    }
    if (!bearer && response.ok) await cacheAuthorization(binding, false);
    const type = response.headers.get('content-type') ?? 'application/octet-stream';
    const disposition = response.headers.get('content-disposition');
    const securityHeaders: Record<string, string> = {};
    for (const header of ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'content-language']) {
      const value = response.headers.get(header); if (value) securityHeaders[header] = value;
    }
    res.status(response.status).setHeader('content-type', type);
    res.setHeader('Cache-Control', 'no-store');
    if (disposition) res.setHeader('content-disposition', disposition);
    for (const [header, value] of Object.entries(securityHeaders)) res.setHeader(header, value);
    if (!bearer && /^\/api\/settings(?:$|\/api-key$)/.test(path) && response.ok && type.includes('application/json')) {
      const body=await response.json();if(body.data)body.data.cli=await cliSettings();res.json(body);return;
    }
    if (!bearer && /^\/api\/v1\/connections(?:\/[^/]+\/config)?$/.test(path) && response.ok && type.includes('application/json')) {
      const body = await response.json();
      if (body.data?.configuration) body.data.configuration = connectionConfiguration(body.data.token ?? '<paste the credential returned once at creation>');
      else if (body.data?.command && body.data?.url) body.data = connectionConfiguration('<paste the credential returned once at creation>');
      res.json(body); return;
    }
    if (type.includes('text/event-stream')) {
      res.flushHeaders();
      if (response.body) for await (const chunk of response.body) { if (res.destroyed) break; res.write(chunk); }
      res.end(); return;
    }
    const chunks: Buffer[] = []; let bytes = 0, cacheable = !bearer && req.method === 'GET' && response.ok && canCache(path);
    if (response.body) for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (cacheable && bytes > cacheLimit) { for (const kept of chunks) res.write(kept); chunks.length = 0; cacheable = false; }
      if (cacheable) chunks.push(buffer); else res.write(buffer);
    }
    if (cacheable) {
      const file = await cachePath(binding, req.url + ':' + (req.headers.accept ?? '')), temp = file + `.${randomUUID()}.tmp`;
      const entry: CachedResponse = { status: response.status, type, securityHeaders, ...(disposition ? { disposition } : {}), body: Buffer.concat(chunks).toString('base64') };
      await writeFile(temp, JSON.stringify(entry), { mode: 0o600 }); await rename(temp, file);
      res.setHeader('X-Dovun-Offline-Available', '1'); res.end(Buffer.concat(chunks));
    } else res.end();
    if (writing && !bearer && response.ok && !path.includes('/preview')) await syncBoundReplicaNow().catch(() => {});
  } catch (error) {
    if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
    if (ownerAuthenticated && !bearer && req.method === 'GET' && canCache(path) && !(error instanceof DomainError && error.code === 'SYNC_AUTH_FAILED') && !await cacheIsDenied(binding)) {
      try {
        const entry = JSON.parse(await readFile(await cachePath(binding, req.url + ':' + (req.headers.accept ?? '')), 'utf8')) as CachedResponse;
        res.status(entry.status).setHeader('content-type', entry.type); res.setHeader('X-Dovun-Offline', '1'); res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Dovun-Offline-Available', '1');
        if (entry.disposition) res.setHeader('content-disposition', entry.disposition);
        for (const [header, value] of Object.entries(entry.securityHeaders ?? {})) res.setHeader(header, value);
        res.end(Buffer.from(entry.body, 'base64')); return;
      } catch { /* Unavailable downloads stay unavailable; never return an empty success. */ }
    }
    next(error instanceof DomainError ? error : new DomainError('SYNC_UNAVAILABLE', '共享工作区暂不可用，本机修改已保留', 502));
  }
}
