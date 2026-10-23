import { runtimeEnv } from '../shared/runtime-env.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
import { DESKTOP_PORT, desktopDataDir, desktopMcpConfiguration, isDesktopPackage, isServerMode, publicWorkspaceUrl } from './desktop-paths.js';

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
export const learningActor: Actor = { id: 'orchestration-learning', kind: 'internal', topicIds: 'all', includeInbox: true, autoActions: [], revision: 1 };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** Process-local proof for the MCP client's fetch to 127.0.0.1. A public request cannot invent it. */
const mcpLoopbackToken = randomBytes(32).toString('base64url');
export function mcpLoopbackHeaders() {
  return { 'x-dovun-loopback': mcpLoopbackToken };
}
function trustedMcpLoopback(req: Request) {
  const given = req.headers['x-dovun-loopback'];
  if (typeof given !== 'string' || given.length !== mcpLoopbackToken.length) return false;
  if (!timingSafeEqual(Buffer.from(given), Buffer.from(mcpLoopbackToken))) return false;
  const peer = req.socket?.remoteAddress ?? '';
  const loopbackPeer = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  return loopbackPeer && loopbackHosts.has(req.hostname);
}
const cookieName = 'dovun_session';
const bootstrapTokens = new Map<string, number>();
/** Prefer the repository root's version; packaged runtimes may only ship server/package.json. */
function readVersion() {
  for (const relative of ['../../../package.json', '../../package.json']) {
    try {
      const version = (createRequire(import.meta.url)(relative) as { version?: string }).version;
      if (version) return version;
    } catch { /* keep looking */ }
  }
  return 'unknown';
}
const serverVersion = readVersion();
export { serverVersion };

/** Startup and tests obtain explicit one-use credentials; there is no authentication bypass. */
export function createOwnerBootstrapToken() {
  const value = token();
  bootstrapTokens.set(hash(value), Date.now() + 10 * 60_000);
  return value;
}

// ---- Server mode owner key -------------------------------------------------
// Local mode logs a fresh one-use bootstrap token at startup. A network-facing
// deployment needs a persistent credential instead: WWA_OWNER_KEY from the
// environment, or a generated key file next to the database.

const ownerKeyMinimum = 20;
let serverOwnerKeyHash: string | null = null;

export function resetOwnerKeyCache() {
  serverOwnerKeyHash = null;
}

function ownerKeyFile() {
  return join(desktopDataDir(), 'owner-key');
}

function equalTokens(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Resolves the server-mode owner key digest, generating and logging the plaintext exactly once. */
export function resolveOwnerKeyHash(): string | null {
  if (!isServerMode()) return null;
  if (serverOwnerKeyHash) return serverOwnerKeyHash;
  const fromEnv = runtimeEnv('OWNER_KEY');
  if (fromEnv) {
    if (fromEnv.length < ownerKeyMinimum) throw new DomainError('OWNER_KEY_INVALID', `DOVUN_OWNER_KEY 至少需要 ${ownerKeyMinimum} 个字符`, 500);
    serverOwnerKeyHash = hash(fromEnv);
    return serverOwnerKeyHash;
  }
  try {
    const stored = readFileSync(ownerKeyFile(), 'utf8').trim();
    if (stored.length >= ownerKeyMinimum) {
      serverOwnerKeyHash = hash(stored);
      return serverOwnerKeyHash;
    }
  } catch { /* fall through to generation */ }
  const generated = token();
  mkdirSync(desktopDataDir(), { recursive: true });
  writeFileSync(ownerKeyFile(), `${generated}\n`, { mode: 0o600 });
  console.log(`Owner access key（仅本次生成时显示，请保存到密码管理器）: ${generated}`);
  serverOwnerKeyHash = hash(generated);
  return serverOwnerKeyHash;
}

// ---- Login rate limiting ---------------------------------------------------
// A network-exposed login endpoint must survive credential guessing.

const loginWindowMs = 15 * 60_000;
const loginMaxFailures = 10;
const loginFailures = new Map<string, number[]>();

export function resetLoginRateLimiter() {
  loginFailures.clear();
}

function clientAddress(req: Request) {
  const forwarded = req.headers['x-forwarded-for'];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim() || req.ip || 'unknown';
}
function loginBlocked(req: Request) {
  const cutoff = Date.now() - loginWindowMs;
  const recent = (loginFailures.get(clientAddress(req)) ?? []).filter((at) => at >= cutoff);
  return recent.length >= loginMaxFailures;
}
function recordLoginFailure(req: Request) {
  const address = clientAddress(req);
  const cutoff = Date.now() - loginWindowMs;
  const recent = (loginFailures.get(address) ?? []).filter((at) => at >= cutoff);
  recent.push(Date.now());
  loginFailures.set(address, recent);
}
function clearLoginFailures(req: Request) {
  loginFailures.delete(clientAddress(req));
}

export function assertOwner(actor: Actor) {
  if (actor.kind !== 'user') throw new DomainError('FORBIDDEN', '此操作需要本机用户确认', 403);
}
export function assertOwnerOrLearningSkill(actor: Actor, kind: string) {
  if (actor.kind === 'internal' && actor.id === learningActor.id && (kind === 'skill.create' || kind === 'skill.update')) return;
  assertOwner(actor);
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
/** Origins the deployment expects browsers to come from: CLIENT_ORIGIN plus the public workspace URL in server mode. */
function configuredOrigins() {
  return [...(process.env.CLIENT_ORIGIN?.split(',').map((item) => item.trim()).filter(Boolean) ?? []), ...(isServerMode() && publicWorkspaceUrl() ? [publicWorkspaceUrl()] : [])];
}
function allowedOrigin(origin: string) {
  const configured = configuredOrigins();
  return (configured.length ? configured : ['http://localhost:5176', 'http://127.0.0.1:5176', 'http://localhost:3016', 'http://127.0.0.1:3016']).includes(origin);
}
export function checkLocalOrigin(req: Request) {
  const origin = req.headers.origin;
  if (origin && !allowedOrigin(origin)) throw new DomainError('ORIGIN_DENIED', '请求来源不受信任', 403);
  if (isServerMode()) {
    if (trustedMcpLoopback(req)) return;
    const hosts = configuredOrigins().map((value) => new URL(value).hostname);
    if (!hosts.length || !hosts.includes(req.hostname)) throw new DomainError('HOST_DENIED', '只允许已配置的工作区地址', 403);
    return;
  }
  const hostname = req.hostname;
  if (!loopbackHosts.has(hostname)) throw new DomainError('HOST_DENIED', '只允许本机工作区地址', 403);
}
export const corsOptions = { credentials: true, origin: (origin: string | undefined, callback: (error: Error | null, allowed?: boolean) => void) => callback(null, !origin || allowedOrigin(origin)) };

const lastUsedThrottleMs = 5 * 60 * 1000;

/**
 * Record that a connection credential was accepted. At most once every five minutes.
 * Does not change `revision` or `updatedAt` (a revision bump would fail later proposal
 * checks with SCOPE_CHANGED) and never throws. Not used for owner-cookie sessions.
 */
export async function touchConnectionLastUsed(id: string) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - lastUsedThrottleMs).toISOString();
  try {
    await prisma.connection.updateMany({
      where: { id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: cutoff } }] },
      data: { lastUsedAt: now.toISOString() },
    });
  } catch { /* a usage timestamp must not fail the request */ }
}

export async function connectionTokenActive(credential: string) {
  const connection = await prisma.connection.findUnique({ where: { tokenHash: hash(credential) } });
  if (connection?.status !== 'active') return false;
  await touchConnectionLastUsed(connection.id);
  return true;
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
    try { await touchConnectionLastUsed(connection.id); }
    catch { /* touchConnectionLastUsed already ignores failures */ }
    return { actor: actorFromConnection(connection) };
  }
  if (!sessionToken) return null;
  const session = await prisma.localSession.findUnique({ where: { tokenHash: hash(sessionToken) } });
  if (!session || session.expiresAt <= new Date().toISOString()) return null;
  const csrfToken = hash(`csrf:${sessionToken}`);
  if (hash(csrfToken) !== session.csrfHash) return null;
  return { actor: ownerActor, csrfToken };
}
export async function requireOwner(req: Request) {
  const identity = await authenticate(req);
  if (!identity || identity.actor.kind !== 'user') throw new DomainError('AUTH_REQUIRED', '请先登录本机工作区', 401);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const given = req.headers['x-csrf-token'];
    const expected = identity.csrfToken!;
    if (typeof given !== 'string' || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) throw new DomainError('CSRF_REQUIRED', '用户会话校验失败，请重新打开工作区', 403);
  }
  return identity;
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
securityRouter.get('/server/info', (_req, res) => {
  res.json({ data: { mode: isServerMode() ? 'server' : 'local', version: serverVersion }, error: null });
});

function cookieSecure(req: Request) {
  return runtimeEnv('PUBLIC_HTTPS') === '1' || req.headers['x-forwarded-proto'] === 'https';
}

/** Bootstrap tokens are single-use launcher credentials for loopback mode; a network deployment must not honor them. */
function grantBootstrapSession(bootstrapToken: string) {
  if (isServerMode()) return false;
  const digest = hash(bootstrapToken);
  const expires = bootstrapTokens.get(digest);
  if (!expires || expires < Date.now()) return false;
  bootstrapTokens.delete(digest);
  return true;
}
function grantOwnerKeySession(ownerKey: string) {
  const expected = resolveOwnerKeyHash();
  if (!expected) return false;
  return equalTokens(hash(ownerKey), expected);
}

securityRouter.post('/auth/session', async (req, res, next) => {
  try {
    checkLocalOrigin(req);
    if (loginBlocked(req)) throw new DomainError('LOGIN_RATE_LIMITED', '尝试次数过多，请 15 分钟后再试', 429);
    const body = z.union([
      z.object({ bootstrapToken: z.string().min(20) }),
      z.object({ ownerKey: z.string().min(ownerKeyMinimum) }),
    ]).parse(req.body);
    const granted = 'ownerKey' in body ? grantOwnerKeySession(body.ownerKey) : grantBootstrapSession(body.bootstrapToken);
    if (!granted) {
      recordLoginFailure(req);
      throw new DomainError('AUTH_REQUIRED', '凭据无效，请核对后重试', 401);
    }
    clearLoginFailures(req);
    const sessionToken = token();
    const csrfToken = hash(`csrf:${sessionToken}`);
    await prisma.localSession.create({ data: { id: token(), tokenHash: hash(sessionToken), csrfHash: hash(csrfToken), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() } });
    res.cookie(cookieName, sessionToken, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 7 * 86_400_000, ...(cookieSecure(req) ? { secure: true } : {}) });
    res.json({ data: { authenticated: true, csrfToken, actor: ownerActor }, error: null });
  } catch (error) { next(error); }
});

export const autoActionNames = ['task.create', 'task.content', 'task.schedule', 'task.complete', 'task.result'] as const;
const connectionSchema = z.object({ name: z.string().trim().min(1), host: z.string().trim().min(1), topicIds: z.array(z.string().min(1)).default([]), includeInbox: z.boolean().default(false), autoActions: z.array(z.enum(autoActionNames)).default([]) });
const publicConnection = ({ tokenHash: _tokenHash, ...value }: { tokenHash: string; topicIds: string; autoActions: string; [key: string]: unknown }) => ({ ...value, topicIds: JSON.parse(value.topicIds), autoActions: JSON.parse(value.autoActions) });
export function connectionConfiguration(credential: string) {
  const entry = fileURLToPath(new URL('../mcp/index.js', import.meta.url)).replace(/[/\\]src[/\\]/, '/dist/');
  const port = Number(process.env.PORT) || (isDesktopPackage() ? DESKTOP_PORT : 3016);
  const api = (isServerMode() && publicWorkspaceUrl()) || `http://127.0.0.1:${port}`;
  const packaged = isDesktopPackage();
  const launch = packaged
    ? desktopMcpConfiguration(entry)
    : developmentMcpConfiguration(entry);
  return {
    ...launch,
    env: { DOVUN_API_URL: api, DOVUN_CONNECTION_TOKEN: credential },
    url: `${api}/mcp`,
    hosts: ['codex', 'claude-code', 'grok'],
  };
}

/** A dev server runs the source tree under tsx, so hosts should not depend on a possibly stale dist build. */
export function developmentMcpConfiguration(distEntry: string, exists: (path: string) => boolean = existsSync) {
  const modulePath = fileURLToPath(import.meta.url); // <server>/src|dist/application/security.ts
  const serverRoot = dirname(dirname(dirname(modulePath)));
  const sourceEntry = join(serverRoot, 'src', 'mcp', 'index.ts');
  // npm workspaces hoist dev dependencies to the repository root; a standalone install keeps them under the server.
  const tsxCli = [serverRoot, dirname(serverRoot)]
    .map((root) => join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'))
    .find(tsxCli => exists(tsxCli));
  if (tsxCli && exists(sourceEntry)) return { command: process.execPath, args: [tsxCli, sourceEntry] };
  return { command: process.execPath, args: [distEntry] };
}
export const connectionRouter = Router();
connectionRouter.use(ownerMiddleware);
connectionRouter.get('/', async (_req, res, next) => {
  try {
    const rows = await prisma.connection.findMany({ orderBy: { createdAt: 'desc' } });
    const topicIdsByConnection = new Map(rows.map((row) => [row.id, JSON.parse(row.topicIds) as string[]]));
    const allTopicIds = [...new Set([...topicIdsByConnection.values()].flat())];
    // Archived topics still have a row, so they are not missing. Same rule as GET /:id/check.
    const existingIds = new Set(allTopicIds.length === 0 ? [] : (await prisma.topic.findMany({ where: { id: { in: allTopicIds } }, select: { id: true } })).map((topic) => topic.id));
    const data = await Promise.all(rows.map(async (row) => {
      const lastWrite = await prisma.changeRecord.findFirst({ where: { connectionId: row.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, operation: true } });
      const lastRequest = await prisma.requestReceipt.findFirst({ where: { actorId: `connection:${row.id}` }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      const missingTopicIds = (topicIdsByConnection.get(row.id) ?? []).filter((id) => !existingIds.has(id));
      return { ...publicConnection(row), lastWriteAt: lastWrite?.createdAt ?? null, lastWriteOperation: lastWrite?.operation ?? null, lastCommandAt: lastRequest?.createdAt ?? null, missingTopicIds, healthy: row.status === 'active' && missingTopicIds.length === 0 };
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
