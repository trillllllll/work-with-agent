import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';

export type Actor = {
  id: string;
  kind: 'user' | 'connection' | 'internal';
  connectionId?: string;
  topicIds: 'all' | string[];
  includeInbox: boolean;
  autoActions: string[];
  revision: number;
};
export const ownerActor: Actor = { id: 'local-owner', kind: 'user', topicIds: 'all', includeInbox: true, autoActions: [], revision: 1 };
export const internalActor: Actor = { id: 'builtin-agent', kind: 'internal', topicIds: 'all', includeInbox: true, autoActions: [], revision: 1 };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const cookieName = 'wwa_session';
const bootstrapTokens = new Map<string, number>();

/** Startup and tests obtain explicit one-use credentials; there is no authentication bypass. */
export function createOwnerBootstrapToken() {
  const value = token();
  bootstrapTokens.set(hash(value), Date.now() + 10 * 60_000);
  return value;
}
export function assertOwner(actor: Actor) {
  if (actor.kind !== 'user') throw new DomainError('FORBIDDEN', '此操作需要本机用户确认', 403);
}
export function assertTopicAccess(actor: Actor, topicId: string | null) {
  if (topicId === null ? !actor.includeInbox : actor.topicIds !== 'all' && !actor.topicIds.includes(topicId)) throw new DomainError('SCOPE_DENIED', '对象不在此连接的授权范围内', 403);
}
export function actorFromConnection(connection: { id: string; topicIds: string; includeInbox: boolean; autoActions: string; revision: number }): Actor {
  return { id: `connection:${connection.id}`, kind: 'connection', connectionId: connection.id, topicIds: JSON.parse(connection.topicIds), includeInbox: connection.includeInbox, autoActions: JSON.parse(connection.autoActions), revision: connection.revision };
}
export async function refreshActor(actor: Actor) {
  if (actor.kind !== 'connection') return actor;
  const row = await prisma.connection.findUnique({ where: { id: actor.connectionId } });
  if (!row || row.status !== 'active') throw new DomainError('CONNECTION_REVOKED', '连接已撤销', 401);
  return actorFromConnection(row);
}
export function getActor(req: Request): Actor {
  const actor = (req as Request & { actor?: Actor }).actor;
  if (!actor) throw new DomainError('AUTH_REQUIRED', '请先登录本机工作区', 401);
  return actor;
}
function cookies(req: Request) {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').flatMap((item) => {
    const separator = item.indexOf('=');
    return separator < 0 ? [] : [[item.slice(0, separator).trim(), item.slice(separator + 1).trim()]];
  }));
}
function allowedOrigin(origin: string) {
  const configured = process.env.CLIENT_ORIGIN?.split(',').map((item) => item.trim()).filter(Boolean);
  return (configured ?? ['http://localhost:5176', 'http://127.0.0.1:5176', 'http://localhost:3016', 'http://127.0.0.1:3016']).includes(origin);
}
export function checkLocalOrigin(req: Request) {
  const origin = req.headers.origin;
  if (origin && !allowedOrigin(origin)) throw new DomainError('ORIGIN_DENIED', '请求来源不受信任', 403);
  const hostname = req.hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) throw new DomainError('HOST_DENIED', '只允许本机工作区地址', 403);
}
export const corsOptions = { credentials: true, origin: (origin: string | undefined, callback: (error: Error | null, allowed?: boolean) => void) => callback(null, !origin || allowedOrigin(origin)) };

export async function connectionTokenActive(credential: string) {
  const connection = await prisma.connection.findUnique({ where: { tokenHash: hash(credential) } });
  return connection?.status === 'active';
}

async function authenticate(req: Request): Promise<{ actor: Actor; csrfToken?: string } | null> {
  checkLocalOrigin(req);
  const authorization = req.headers.authorization;
  const sessionToken = cookies(req)[cookieName];
  if (authorization && sessionToken) throw new DomainError('AMBIGUOUS_IDENTITY', '不能同时提交连接凭据和用户会话', 400);
  if (authorization) {
    if (!authorization.startsWith('Bearer ')) throw new DomainError('AUTH_REQUIRED', '连接凭据无效', 401);
    const connection = await prisma.connection.findUnique({ where: { tokenHash: hash(authorization.slice(7)) } });
    if (!connection || connection.status !== 'active') throw new DomainError('AUTH_REQUIRED', '连接凭据无效或已撤销', 401);
    return { actor: actorFromConnection(connection) };
  }
  if (!sessionToken) return null;
  const session = await prisma.localSession.findUnique({ where: { tokenHash: hash(sessionToken) } });
  if (!session || session.expiresAt <= new Date().toISOString()) return null;
  const csrfToken = hash(`csrf:${sessionToken}`);
  if (hash(csrfToken) !== session.csrfHash) return null;
  return { actor: ownerActor, csrfToken };
}
export async function identityMiddleware(req: Request, _res: Response, next: NextFunction) {
  try {
    const identity = await authenticate(req);
    if (!identity) throw new DomainError('AUTH_REQUIRED', '请先登录本机工作区', 401);
    if (identity.actor.kind === 'user' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const given = req.headers['x-csrf-token'];
      const expected = identity.csrfToken!;
      if (typeof given !== 'string' || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) throw new DomainError('CSRF_REQUIRED', '用户会话校验失败，请重新打开工作区', 403);
    }
    (req as Request & { actor: Actor }).actor = identity.actor;
    next();
  } catch (error) { next(error); }
}
export function ownerMiddleware(req: Request, _res: Response, next: NextFunction) {
  try { assertOwner(getActor(req)); next(); } catch (error) { next(error); }
}

export const securityRouter = Router();
securityRouter.get('/auth/session', async (req, res, next) => {
  try {
    const identity = await authenticate(req);
    res.json({ data: { authenticated: identity?.actor.kind === 'user', ...(identity?.actor.kind === 'user' ? { csrfToken: identity.csrfToken, actor: identity.actor } : {}) }, error: null });
  } catch (error) { next(error); }
});
securityRouter.post('/auth/session', async (req, res, next) => {
  try {
    checkLocalOrigin(req);
    const { bootstrapToken } = z.object({ bootstrapToken: z.string().min(20) }).parse(req.body);
    const digest = hash(bootstrapToken);
    const expires = bootstrapTokens.get(digest);
    if (!expires || expires < Date.now()) throw new DomainError('BOOTSTRAP_EXPIRED', '启动凭据无效或已过期，请从启动器重新打开', 401);
    bootstrapTokens.delete(digest);
    const sessionToken = token();
    const csrfToken = hash(`csrf:${sessionToken}`);
    await prisma.localSession.create({ data: { id: token(), tokenHash: hash(sessionToken), csrfHash: hash(csrfToken), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() } });
    res.cookie(cookieName, sessionToken, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 7 * 86_400_000 });
    res.json({ data: { authenticated: true, csrfToken, actor: ownerActor }, error: null });
  } catch (error) { next(error); }
});

export const autoActionNames = ['task.create', 'task.content', 'task.schedule', 'task.complete', 'task.result'] as const;
const connectionSchema = z.object({ name: z.string().trim().min(1), host: z.string().trim().min(1), topicIds: z.array(z.string().min(1)).default([]), includeInbox: z.boolean().default(false), autoActions: z.array(z.enum(autoActionNames)).default([]) });
const publicConnection = ({ tokenHash: _tokenHash, ...value }: { tokenHash: string; topicIds: string; autoActions: string; [key: string]: unknown }) => ({ ...value, topicIds: JSON.parse(value.topicIds), autoActions: JSON.parse(value.autoActions) });
function connectionConfiguration(credential: string) {
  const entry = fileURLToPath(new URL('../mcp/index.js', import.meta.url)).replace(/[/\\]src[/\\]/, '/dist/');
  const api = `http://127.0.0.1:${Number(process.env.PORT) || 3016}`;
  return { command: process.execPath, args: [entry], env: { WWA_API_URL: api, WWA_CONNECTION_TOKEN: credential }, url: `${api}/mcp`, hosts: ['codex', 'claude-code', 'grok'] };
}
export const connectionRouter = Router();
connectionRouter.use(ownerMiddleware);
connectionRouter.get('/', async (_req, res, next) => {
  try {
    const rows = await prisma.connection.findMany({ orderBy: { createdAt: 'desc' } });
    const data = await Promise.all(rows.map(async (row) => {
      const lastWrite = await prisma.changeRecord.findFirst({ where: { connectionId: row.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, operation: true } });
      const lastRequest = await prisma.requestReceipt.findFirst({ where: { actorId: `connection:${row.id}` }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      return { ...publicConnection(row), lastWriteAt: lastWrite?.createdAt ?? null, lastWriteOperation: lastWrite?.operation ?? null, lastCommandAt: lastRequest?.createdAt ?? null };
    }));
    res.json({ data, error: null });
  } catch (error) { next(error); }
});
connectionRouter.get('/:id/check', async (req, res, next) => {
  try {
    const row = await prisma.connection.findUnique({ where: { id: String(req.params.id) } });
    if (!row) throw new DomainError('NOT_FOUND', '连接不存在', 404);
    const ids = JSON.parse(row.topicIds) as string[];
    const topics = await prisma.topic.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, archivedAt: true } });
    const missingTopicIds = ids.filter((id) => !topics.some((topic) => topic.id === id));
    res.json({ data: { healthy: row.status === 'active' && missingTopicIds.length === 0, status: row.status, revision: row.revision, topics, missingTopicIds, includeInbox: row.includeInbox, autoActions: JSON.parse(row.autoActions), defaultPolicy: 'proposal', checks: { credentialActive: row.status === 'active', scopeResolved: missingTopicIds.length === 0 } }, error: null });
  } catch (error) { next(error); }
});
connectionRouter.get('/:id/config', async (req, res, next) => {
  try {
    const row = await prisma.connection.findUnique({ where: { id: String(req.params.id) } });
    if (!row) throw new DomainError('NOT_FOUND', '连接不存在', 404);
    res.json({ data: connectionConfiguration('<paste the credential returned once at creation>'), error: null });
  } catch (error) { next(error); }
});
connectionRouter.post('/', async (req, res, next) => {
  try {
    const input = connectionSchema.parse(req.body);
    const ids = [...new Set(input.topicIds)];
    if (await prisma.topic.count({ where: { id: { in: ids } } }) !== ids.length) throw new DomainError('NOT_FOUND', '部分清单不存在', 404);
    const credential = token();
    const timestamp = new Date().toISOString();
    const row = await prisma.connection.create({ data: { ...input, topicIds: JSON.stringify(ids), autoActions: JSON.stringify([...new Set(input.autoActions)]), tokenHash: hash(credential), createdAt: timestamp, updatedAt: timestamp } });
    res.json({ data: { ...publicConnection(row), token: credential, configuration: connectionConfiguration(credential) }, error: null });
  } catch (error) { next(error); }
});
connectionRouter.patch('/:id', async (req, res, next) => {
  try {
    const { expectedRevision, ...raw } = z.object({ expectedRevision: z.number().int().min(1) }).passthrough().parse(req.body);
    const input = connectionSchema.partial().parse(raw);
    if (input.topicIds && await prisma.topic.count({ where: { id: { in: [...new Set(input.topicIds)] } } }) !== new Set(input.topicIds).size) throw new DomainError('NOT_FOUND', '部分清单不存在', 404);
    const { topicIds, autoActions, ...fields } = input;
    const changed = await prisma.connection.updateMany({ where: { id: String(req.params.id), revision: expectedRevision, status: 'active' }, data: { ...fields, ...(topicIds ? { topicIds: JSON.stringify([...new Set(topicIds)]) } : {}), ...(autoActions ? { autoActions: JSON.stringify([...new Set(autoActions)]) } : {}), revision: { increment: 1 }, updatedAt: new Date().toISOString() } });
    if (!changed.count) throw new DomainError('VERSION_CONFLICT', '连接已发生变化，请刷新');
    res.json({ data: publicConnection((await prisma.connection.findUniqueOrThrow({ where: { id: String(req.params.id) } }))), error: null });
  } catch (error) { next(error); }
});
connectionRouter.delete('/:id', async (req, res, next) => {
  try {
    const { expectedRevision } = z.object({ expectedRevision: z.number().int().min(1) }).parse(req.body);
    const changed = await prisma.connection.updateMany({ where: { id: String(req.params.id), revision: expectedRevision, status: 'active' }, data: { status: 'revoked', revision: { increment: 1 }, updatedAt: new Date().toISOString() } });
    if (!changed.count) throw new DomainError('VERSION_CONFLICT', '连接已发生变化，请刷新');
    res.json({ data: { revoked: true }, error: null });
  } catch (error) { next(error); }
});
