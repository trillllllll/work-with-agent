import type { Prisma } from '@prisma/client';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
import { deepseekKey } from '../application/deepseek-settings.js';
import { fetchWholeWebPage, searchWeb } from './web-search.js';
import { contentQuality, normalizeWebUrl, readCachedPage, webHash, webReadInput, webSearchInput } from './web-content.js';

export const WEB_REQUEST_LIMITS = { web_search: 6, read_webpage: 10 } as const;
export const WEB_WAIT_MS = 180000;
type Kind = keyof typeof WEB_REQUEST_LIMITS;
type Session = { runId: string; leaseToken: string; callKey: string };
type Result = { success: boolean; data?: unknown; code?: string; error?: string; budget?: WebBudget };
type Usage = { kind: string; chargedMs: number; category: string | null };
export function requestBudget(rows: Usage[]) {
  const used = { web_search: rows.filter(row => row.kind === 'web_search').length, read_webpage: rows.filter(row => row.kind === 'read_webpage').length };
  const remaining = { web_search: Math.max(0, WEB_REQUEST_LIMITS.web_search - used.web_search), read_webpage: Math.max(0, WEB_REQUEST_LIMITS.read_webpage - used.read_webpage) };
  const elapsedMs = rows.reduce((sum, row) => sum + row.chargedMs, 0);
  const stopReason = rows.some(row => row.category === 'auth_error') ? 'auth_error' : elapsedMs >= WEB_WAIT_MS ? 'wait_limit' : !remaining.web_search && !remaining.read_webpage ? 'request_limit' : null;
  return { used, remaining, elapsedMs, canSearch: !stopReason && remaining.web_search > 0, canFetch: !stopReason && remaining.read_webpage > 0, canNetwork: !stopReason && !!(remaining.web_search || remaining.read_webpage), stopReason };
}
export type WebBudget = ReturnType<typeof requestBudget>;
const usageSelect = { kind: true, chargedMs: true, category: true } as const;
export async function webSessionState(runId: string) {
  const rows = await prisma.agentWebRequest.findMany({ where: { runId }, select: usageSelect });
  const pages = await prisma.agentWebPage.findMany({ where: { runId }, select: { url: true, title: true } });
  return { budget: requestBudget(rows), cachedPages: pages };
}
async function owned(tx: Prisma.TransactionClient, session: Session) {
  const run = await tx.agentRun.findUnique({ where: { id: session.runId }, select: { state: true, leaseToken: true, leaseExpiresAt: true, conversation: { select: { activeRunId: true } } } });
  if (!run || run.state !== 'running' || run.leaseToken !== session.leaseToken || !run.leaseExpiresAt || run.leaseExpiresAt <= new Date().toISOString() || run.conversation.activeRunId !== session.runId) throw new DomainError('LEASE_LOST', '请求已停止或失去执行权');
}
const failure = (status: string, note: string): Result => ({ success: false, code: status.toUpperCase(), error: note, data: { status } });
function classify(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const code = error instanceof DomainError ? error.code : '';
  if (code === 'WEB_SEARCH_AUTH') return { status: 'auth_error', retryable: false };
  if (code === 'WEB_SEARCH_RATE_LIMITED') return { status: 'rate_limited', retryable: true };
  if (/超时/.test(message)) return { status: 'timeout', retryable: true };
  if (/拒绝访问/.test(message)) return { status: 'suspected_blocked', retryable: false };
  if (/没有从该页面/.test(message)) return { status: 'empty_content', retryable: false };
  return { status: 'provider_error', retryable: /无法连接|服务返回 5\d\d/.test(message) };
}

/** Durable reservation precedes I/O. An unknown prior outcome is never silently replayed. */
export async function executeSessionWeb(kind: Kind, raw: unknown, session: Session): Promise<Result> {
  const withBudget = async (result: Result): Promise<Result> => ({ ...result, budget: (await webSessionState(session.runId)).budget });
  const parsed = kind === 'web_search' ? webSearchInput.safeParse(raw) : webReadInput.safeParse(raw);
  if (!parsed.success) return withBudget(failure('invalid_arguments', '联网工具参数无效；query 和 cursor 不能同时使用。'));
  const search = kind === 'web_search' ? webSearchInput.parse(raw) : null;
  const read = kind === 'read_webpage' ? webReadInput.parse(raw) : null;
  const target = read ? normalizeWebUrl(read.url) : null;
  const hash = webHash(target?.url ?? search!.query.normalize('NFKC').replace(/\s+/g, ' '));
  const prior = await prisma.agentWebRequest.findUnique({ where: { runId_callKey: { runId: session.runId, callKey: session.callKey } } });
  if (prior) return withBudget(prior.resultJson ? JSON.parse(prior.resultJson) as Result : prior.state === 'completed' ? failure('cache_expired', '此请求的缓存已过期，预算记录仍保留；不会自动重新联网。') : failure('provider_error', '之前的请求已发出但结果未知，已计入预算；为避免重复请求，本次不重发。'));
  if (read && target) {
    const page = await prisma.agentWebPage.findUnique({ where: { runId_urlHash: { runId: session.runId, urlHash: hash } } });
    if (page) {
      const data = readCachedPage(page, { cursor: read.cursor, query: read.query ?? (!read.cursor ? target.fragment || undefined : undefined) });
      return withBudget(data.status === 'invalid_cursor' ? { ...failure('invalid_cursor', '请使用该页面返回的有效游标。'), data: { ...data, cacheHit: true } } : { success: true, data: { ...data, cacheHit: true } });
    }
    // Cursor validation never incurs a network request, including missing/expired pages.
    if (read.cursor) return withBudget(failure('invalid_cursor', '此任务没有对应的缓存页面；去掉游标可重新读取，不能沿用其他任务的游标。'));
  }
  if (!await deepseekKey()) return withBudget(failure('provider_error', '尚未配置 DeepSeek 联网服务。'));
  const reserved = await prisma.$transaction(async tx => {
    await owned(tx, session);
    const duplicate = await tx.agentWebRequest.findUnique({ where: { runId_callKey: { runId: session.runId, callKey: session.callKey } } });
    if (duplicate) return { result: duplicate.resultJson ? JSON.parse(duplicate.resultJson) as Result : failure('provider_error', '该请求结果未知，不重复执行。') };
    const rows = await tx.agentWebRequest.findMany({ where: { runId: session.runId }, select: { ...usageSelect, targetHash: true, state: true, retryable: true, resultJson: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const budget = requestBudget(rows);
    const same = rows.filter(row => row.kind === kind && row.targetHash === hash);
    if (same.length && (same.length >= 2 || !same[0].retryable || same[0].state !== 'completed')) {
      // Reuse successful/empty searches, not the last error's opaque provider response.
      if (kind === 'web_search' && same[0].resultJson) {
        const previous = JSON.parse(same[0].resultJson) as Result;
        if (previous.success) return { result: { ...previous, data: { ...(previous.data as object), cacheHit: true } } };
      }
      return { result: failure('budget_exhausted', '该目标已请求过，且不满足重试条件；请使用已有资料或调整查询。') };
    }
    if (!(kind === 'web_search' ? budget.canSearch : budget.canFetch)) return { result: failure('budget_exhausted', '此类外部请求或累计等待预算已用尽；请查看budget，阅读已有资料并整理答案。') };
    const timeoutMs = Math.min(kind === 'web_search' ? 15000 : 30000, WEB_WAIT_MS - budget.elapsedMs);
    const request = await tx.agentWebRequest.create({ data: { runId: session.runId, callKey: session.callKey, kind, targetHash: hash, chargedMs: timeoutMs, createdAt: new Date().toISOString() } });
    return { request, timeoutMs };
  });
  if ('result' in reserved) return withBudget(reserved.result!);
  const began = performance.now();
  let result: Result, category = 'ok', retryable = false;
  let pageData: { title: string | null; content: string } | undefined;
  try {
    if (search) {
      const data = await searchWeb(search, reserved.timeoutMs);
      category = data.resultCount ? 'ok' : 'empty_results';
      result = { success: true, data: { ...data, status: category, sourceType: 'search_snippet', cacheHit: false, ...(data.resultCount ? {} : { note: '没有结果；本次外部请求已计入预算，请调整关键词。' }) } };
    } else {
      const data = await fetchWholeWebPage(target!.url, reserved.timeoutMs);
      category = contentQuality(data.content ?? '');
      if (category !== 'ok') result = failure(category, category === 'empty_content' ? '页面未返回正文。' : '页面可能为登录墙、验证码或访问拦截提示。');
      else {
        pageData = { title: data.title?.slice(0, 300) ?? null, content: data.content! };
        result = { success: true };
      }
    }
  } catch (error) {
    ({ status: category, retryable } = classify(error));
    // Only controlled messages reach the model; arbitrary provider errors can contain URLs/credentials.
    const note = category === 'timeout' ? '联网请求超时，可在预算内再尝试一次。' : category === 'auth_error' ? '联网认证或余额不可用，本任务停止外部请求。' : category === 'rate_limited' ? '联网服务限流，可稍后在预算内重试。' : '联网服务未返回可用内容。';
    result = failure(category, note);
  }
  const elapsed = Math.min(reserved.timeoutMs, Math.max(0, Math.ceil(performance.now() - began)));
  await prisma.$transaction(async tx => {
    await owned(tx, session);
    if (pageData) {
      const sizes = await tx.agentWebPage.aggregate({ where: { runId: session.runId }, _sum: { bytes: true }, _count: true });
      const bytes = Buffer.byteLength(pageData.content);
      const existing = await tx.agentWebPage.findUnique({ where: { runId_urlHash: { runId: session.runId, urlHash: hash } } });
      if (existing) result = { success: true, data: { ...readCachedPage(existing, { query: read!.query ?? (target!.fragment || undefined) }), cacheHit: true } };
      else if (sizes._count >= 10 || (sizes._sum.bytes ?? 0) + bytes > 8 * 1024 * 1024) {
        category = 'cache_limit'; result = failure(category, '本任务页面缓存已达上限；未保存此页，也未静默截断。');
      } else {
        const page = await tx.agentWebPage.create({ data: { runId: session.runId, url: target!.url, urlHash: hash, version: webHash(pageData.content), ...pageData, bytes, fetchedAt: new Date().toISOString() } });
        result = { success: true, data: { ...readCachedPage(page, { query: read!.query ?? (target!.fragment || undefined) }), cacheHit: false } };
      }
    }
    await tx.agentWebRequest.update({ where: { id: reserved.request.id }, data: { state: 'completed', chargedMs: elapsed, category, retryable, resultJson: JSON.stringify(result) } });
  });
  return withBudget(result!);
}

let lastCleanup = 0;
export async function cleanupWebResources(now = Date.now()) {
  if (now - lastCleanup < 3600000) return;
  try {
    const where = { run: { OR: [
      { state: { in: ['completed', 'failed', 'cancelled'] }, completedAt: { lt: new Date(now - 86400000).toISOString() } },
      { state: 'paused', updatedAt: { lt: new Date(now - 7 * 86400000).toISOString() } },
    ] } };
    const pages = await prisma.agentWebPage.findMany({ where, select: { id: true }, take: 100 });
    await prisma.agentWebPage.deleteMany({ where: { id: { in: pages.map(page => page.id) } } });
    const requests = await prisma.agentWebRequest.findMany({ where: { run: { state: { in: ['completed', 'failed', 'cancelled'] }, completedAt: { lt: new Date(now - 86400000).toISOString() } } }, select: { id: true }, take: 100 });
    await prisma.agentWebRequest.deleteMany({ where: { id: { in: requests.map(request => request.id) } } });
    const stalePayloads = await prisma.agentWebRequest.findMany({ where: { resultJson: { not: null }, run: { state: 'paused', updatedAt: { lt: new Date(now - 7 * 86400000).toISOString() } } }, select: { id: true }, take: 100 });
    await prisma.agentWebRequest.updateMany({ where: { id: { in: stalePayloads.map(request => request.id) } }, data: { resultJson: null } });
    // Drain backlogs in bounded batches on subsequent scheduler ticks; only idle for an hour once drained.
    if (pages.length < 100 && requests.length < 100 && stalePayloads.length < 100) lastCleanup = now;
  } catch { /* Resource retention must not stop chat or expose provider data in logs. */ }
}
