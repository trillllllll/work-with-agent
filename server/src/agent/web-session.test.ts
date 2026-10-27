import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../infrastructure/prisma.js';
import { contentQuality, readCachedPage, webHash, type WebPage } from './web-content.js';
import { cleanupWebResources, executeSessionWeb, requestBudget, webSessionState } from './web-session.js';

const conversations: string[] = [];
async function session() {
  const now = new Date().toISOString();
  const conversation = await prisma.conversation.create({ data: { createdAt: now, updatedAt: now } });
  conversations.push(conversation.id);
  const message = await prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content: '官方文档', createdAt: now } });
  const run = await prisma.agentRun.create({ data: { conversationId: conversation.id, sourceUserMessageId: message.id, requestKey: randomUUID(), requestHash: 'test', state: 'running', leaseToken: 'owner', leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), contextJson: '{}', modelMessagesJson: '[]', cursorJson: '{}', createdAt: now, updatedAt: now } });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { activeRunId: run.id } });
  return { runId: run.id, leaseToken: 'owner', callKey: randomUUID() };
}
const page = (content: string): WebPage => ({ id: 'page', runId: 'run', url: 'https://go.dev/ref/spec', version: webHash(content), title: 'The Go Programming Language Specification', content, fetchedAt: new Date().toISOString() });
const data = (result: { data?: unknown }) => result.data as any;
beforeEach(() => { process.env.DEEPSEEK_API_KEY = 'fixture-only'; delete process.env.WEB_SEARCH_PROXY_URL; });
afterEach(async () => {
  vi.restoreAllMocks(); delete process.env.DEEPSEEK_API_KEY;
  await prisma.conversation.deleteMany({ where: { id: { in: conversations.splice(0) } } });
});

describe('cached document navigation', () => {
  it('reads a 240k-character document after the old cutoff, with bound Unicode positions', () => {
    const p = page('😀'.repeat(90000) + '\n## Conversions\nInteger conversion rules\n' + 'z'.repeat(150000));
    const found = readCachedPage(p, { query: 'Conversions' }) as any;
    expect(found.windows[0].start).toBeGreaterThan(60000);
    expect(found.windows[0].content).toContain('## Conversions');
    const continued = readCachedPage(p, { cursor: found.windows[0].cursor }) as any;
    expect(continued.offset).toBe(found.windows[0].start);
    expect([...continued.content].length).toBeLessThanOrEqual(12000);
    expect(readCachedPage({ ...p, runId: 'another' }, { cursor: found.windows[0].cursor }).status).toBe('invalid_cursor');
    expect(readCachedPage({ ...p, version: 'changed' }, { cursor: found.windows[0].cursor }).status).toBe('invalid_cursor');
    expect(readCachedPage(p, { query: '类型转换' })).toMatchObject({ status: 'no_match', headings: [{ title: 'Conversions' }] });
  });
  it('keeps short valid content and rejects blank/blocking content', () => {
    const longLine = page('x'.repeat(80000) + ' needleTarget ' + 'x'.repeat(80000));
    expect((readCachedPage(longLine, { query: 'needleTarget' }) as any).windows[0].content).toContain('needleTarget');
    expect(contentQuality('const Pi = 3.14; Constants are immutable.')).toBe('ok');
    expect(contentQuality('  \n')).toBe('empty_content');
    expect(contentQuality('Access denied. Verify you are human.')).toBe('suspected_blocked');
  });
});

describe('durable request budget and cache', () => {
  it('counts empty searches and enforces the boundary within a batch', async () => {
    const s = await session();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ results: [] }));
    for (let i = 0; i < 6; i++) {
      const result = await executeSessionWeb('web_search', { query: `go query ${i}` }, { ...s, callKey: `${i}` });
      expect(data(result).status).toBe('empty_results');
      expect(result.budget!.remaining.web_search).toBe(5 - i);
    }
    expect((await executeSessionWeb('web_search', { query: 'extra' }, { ...s, callKey: 'extra' })).code).toBe('BUDGET_EXHAUSTED');
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
  it('fetches once for fragments, paging, repeated reads and section queries, even after auth stops network', async () => {
    const s = await session();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ title: 'Spec', content: 'x'.repeat(70000) + '\n## Conversions\nUnicode values' }));
    const first = await executeSessionWeb('read_webpage', { url: 'https://go.dev/ref/spec?a=1' }, s);
    const second = await executeSessionWeb('read_webpage', { url: 'https://go.dev/ref/spec?a=1', cursor: data(first).nextCursor }, { ...s, callKey: 'second' });
    expect(data(second).offset).toBe(12000);
    const found = await executeSessionWeb('read_webpage', { url: 'https://go.dev/ref/spec?a=1#Conversions' }, { ...s, callKey: 'fragment' });
    expect(data(found).windows[0].content).toContain('Conversions');
    expect(found.budget!.used.read_webpage).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(new Response('', { status: 401 }));
    expect((await executeSessionWeb('web_search', { query: 'go' }, { ...s, callKey: 'auth' })).budget!.stopReason).toBe('auth_error');
    expect(data(await executeSessionWeb('read_webpage', { url: 'https://go.dev/ref/spec?a=1', query: 'Conversions' }, { ...s, callKey: 'cached' })).cacheHit).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not fetch for invalid/cross-run cursors or a conflicting query parameter', async () => {
    const s = await session();
    const fetcher = vi.spyOn(globalThis, 'fetch');
    expect((await executeSessionWeb('read_webpage', { url: 'https://go.dev', cursor: 'bad' }, s)).code).toBe('INVALID_CURSOR');
    expect((await executeSessionWeb('read_webpage', { url: 'https://go.dev', cursor: 'bad', query: 'x' }, s)).code).toBe('INVALID_ARGUMENTS');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('replays a completed call and conservatively preserves an unknown reservation after restart', async () => {
    const s = await session();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ results: [{ title: 'Go', url: 'https://go.dev' }] }));
    const first = await executeSessionWeb('web_search', { query: 'go' }, s);
    expect((await executeSessionWeb('web_search', { query: 'go' }, s)).data).toEqual(first.data);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await prisma.agentWebRequest.create({ data: { runId: s.runId, callKey: 'unknown', kind: 'read_webpage', targetHash: webHash('https://go.dev/'), chargedMs: 30000, createdAt: new Date().toISOString() } });
    expect((await executeSessionWeb('read_webpage', { url: 'https://go.dev' }, { ...s, callKey: 'unknown' })).success).toBe(false);
    expect((await executeSessionWeb('read_webpage', { url: 'https://go.dev' }, { ...s, callKey: 'new-id' })).success).toBe(false);
    expect((await webSessionState(s.runId)).budget.elapsedMs).toBeGreaterThanOrEqual(30000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('permits one retry for 5xx and none for empty/blocked/successful targets', async () => {
    const s = await session();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 503 }));
    for (let i = 0; i < 3; i++) await executeSessionWeb('web_search', { query: 'retry' }, { ...s, callKey: `retry${i}` });
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockImplementation(async () => Response.json({ title: 'blocked', content: '请先登录后继续查看' }));
    const blocked = await executeSessionWeb('read_webpage', { url: 'https://go.dev/blocked' }, { ...s, callKey: 'blocked' });
    expect(data(blocked).status).toBe('suspected_blocked');
    await executeSessionWeb('read_webpage', { url: 'https://go.dev/blocked' }, { ...s, callKey: 'blocked2' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('isolates runs, query strings and lost execution leases', async () => {
    const s = await session(), other = await session();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ content: 'A valid short tutorial defining constants.' }));
    await executeSessionWeb('read_webpage', { url: 'https://go.dev/?a=1' }, s);
    await executeSessionWeb('read_webpage', { url: 'https://go.dev/?a=2' }, { ...s, callKey: 'different' });
    await executeSessionWeb('read_webpage', { url: 'https://go.dev/?a=1' }, other);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await expect(executeSessionWeb('web_search', { query: 'new' }, { ...s, callKey: 'stale', leaseToken: 'old' })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('rejects an expired executor before HTTP or cache persistence', async () => {
    const s = await session();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ content: 'Valid content.' }));
    await prisma.agentRun.update({ where: { id: s.runId }, data: { leaseExpiresAt: new Date(Date.now() - 1).toISOString() } });
    await expect(executeSessionWeb('read_webpage', { url: 'https://go.dev' }, s)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(fetcher).not.toHaveBeenCalled();
    await prisma.agentRun.update({ where: { id: s.runId }, data: { leaseExpiresAt: new Date(Date.now() + 120000).toISOString() } });
    fetcher.mockImplementationOnce(async () => {
      await prisma.agentRun.update({ where: { id: s.runId }, data: { leaseExpiresAt: new Date(Date.now() - 1).toISOString() } });
      return Response.json({ content: 'Late content must not commit.' });
    });
    await expect(executeSessionWeb('read_webpage', { url: 'https://go.dev' }, s)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect((await webSessionState(s.runId)).cachedPages).toHaveLength(0);
    expect((await webSessionState(s.runId)).budget.used.read_webpage).toBe(1);
  });
  it('retains cache reads at the waiting limit and rejects new I/O', async () => {
    expect(requestBudget(Array.from({ length: 6 }, () => ({ kind: 'read_webpage', chargedMs: 30000, category: null })))).toMatchObject({ canNetwork: false, stopReason: 'wait_limit' });
    const s = await session();
    for (let i = 0; i < 6; i++) await prisma.agentWebRequest.create({ data: { runId: s.runId, callKey: `timeout-${i}`, kind: 'read_webpage', targetHash: `hash${i}`, chargedMs: 30000, createdAt: new Date().toISOString() } });
    const fetcher = vi.spyOn(globalThis, 'fetch');
    expect((await executeSessionWeb('web_search', { query: 'go' }, s)).code).toBe('BUDGET_EXHAUSTED');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not cache an oversize document and reports byte/page capacity explicitly', async () => {
    const s = await session();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ content: 'x'.repeat(1024 * 1024 + 1) }));
    expect((await executeSessionWeb('read_webpage', { url: 'https://go.dev/huge' }, s)).success).toBe(false);
    expect((await webSessionState(s.runId)).cachedPages).toHaveLength(0);
    await prisma.agentWebPage.create({ data: { runId: s.runId, url: 'https://go.dev/full', urlHash: webHash('https://go.dev/full'), version: 'test', content: 'fixture', bytes: 8 * 1024 * 1024, fetchedAt: new Date().toISOString() } });
    fetcher.mockImplementation(async () => Response.json({ content: 'Another valid document.' }));
    expect((await executeSessionWeb('read_webpage', { url: 'https://go.dev/extra' }, { ...s, callKey: 'extra' })).code).toBe('CACHE_LIMIT');
    expect((await webSessionState(s.runId)).cachedPages).toHaveLength(1);
  });
  it('allows ten external fetches and keeps navigation available after the fetch quota', async () => {
    const s = await session();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ content: 'A valid short page.' }));
    for (let i = 0; i < 10; i++) await executeSessionWeb('read_webpage', { url: `https://go.dev/page${i}` }, { ...s, callKey: `page${i}` });
    expect((await executeSessionWeb('read_webpage', { url: 'https://go.dev/extra' }, s)).code).toBe('BUDGET_EXHAUSTED');
    expect(data(await executeSessionWeb('read_webpage', { url: 'https://go.dev/page0' }, { ...s, callKey: 'cached' })).cacheHit).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(10);
  });
  it('does not retry malformed HTTP200 responses, and deduplicates concurrent calls', async () => {
    const s = await session();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ results: 'invalid' }));
    const invalid = await executeSessionWeb('web_search', { query: 'malformed' }, s);
    expect(data(invalid).status).toBe('provider_error');
    await executeSessionWeb('web_search', { query: 'malformed' }, { ...s, callKey: 'second' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementation(async () => Response.json({ results: [] }));
    await Promise.all([executeSessionWeb('web_search', { query: 'concurrent' }, { ...s, callKey: 'concurrent' }), executeSessionWeb('web_search', { query: 'concurrent' }, { ...s, callKey: 'concurrent' })]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('cleans expired terminal resources without deleting a live run cache', async () => {
    const s = await session();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ content: 'Short valid documentation.' }));
    await executeSessionWeb('read_webpage', { url: 'https://go.dev' }, s);
    await cleanupWebResources(Date.now() + 2 * 86400000);
    expect((await webSessionState(s.runId)).cachedPages).toHaveLength(1);
    await prisma.agentRun.update({ where: { id: s.runId }, data: { state: 'completed', completedAt: new Date().toISOString() } });
    await prisma.agentWebPage.createMany({ data: Array.from({ length: 120 }, (_, i) => ({ id: randomUUID(), runId: s.runId, url: `https://fixture.test/${i}`, urlHash: `fixture${i}`, version: 'test', content: 'expired', bytes: 7, fetchedAt: new Date().toISOString() })) });
    const cleanupNow = Date.now() + 3 * 86400000;
    await cleanupWebResources(cleanupNow);
    expect((await webSessionState(s.runId)).cachedPages).toHaveLength(21);
    await cleanupWebResources(cleanupNow);
    expect((await webSessionState(s.runId)).cachedPages).toHaveLength(0);
    const paused = await session();
    await executeSessionWeb('read_webpage', { url: 'https://go.dev' }, paused);
    await prisma.agentRun.update({ where: { id: paused.runId }, data: { state: 'paused', updatedAt: new Date().toISOString() } });
    await cleanupWebResources(Date.now() + 11 * 86400000);
    const history = await prisma.agentWebRequest.findMany({ where: { runId: paused.runId } });
    expect(history).toHaveLength(1);
    expect(history[0].resultJson).toBeNull();
    expect((await webSessionState(paused.runId)).cachedPages).toHaveLength(0);
    expect((await webSessionState(paused.runId)).budget.used.read_webpage).toBe(1);
  });
});

describe('fixed-response learning replay', () => {
  const topics = ['Go Conversions', 'Go Constants', 'Go Zero values', 'Go Maps', 'Go Strings', 'Python sqlite3', 'Java Optional', 'JavaScript Promise', 'TypeScript Generics', 'SQLite transactions'];
  it.each(topics)('%s: reuses one fetch for reading, paging, revisiting and section lookup', async topic => {
    const s = await session();
    const content = 'Introduction\n' + 'x'.repeat(70000) + `\n## ${topic}\nOfficial definition and example.\n` + 'y'.repeat(180000);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).endsWith('/search')
      ? Response.json({ results: [{ title: topic, url: 'https://docs.example.org/spec', snippet: 'Official overview' }] })
      : Response.json({ title: topic, content }));
    const searched = await executeSessionWeb('web_search', { query: topic }, s);
    expect(data(searched).sourceType).toBe('search_snippet');
    const first = await executeSessionWeb('read_webpage', { url: 'https://docs.example.org/spec' }, { ...s, callKey: 'read' });
    const second = await executeSessionWeb('read_webpage', { url: 'https://docs.example.org/spec', cursor: data(first).nextCursor }, { ...s, callKey: 'next' });
    expect(data(second).offset).toBe(12000);
    await executeSessionWeb('read_webpage', { url: 'https://docs.example.org/spec' }, { ...s, callKey: 'again' });
    const found = await executeSessionWeb('read_webpage', { url: 'https://docs.example.org/spec', query: topic }, { ...s, callKey: 'find' });
    expect(data(found).windows[0].content).toContain(`## ${topic}`);
    expect(data(found).windows[0].start).toBeGreaterThan(60000);
    expect(found.budget!.used).toEqual({ web_search: 1, read_webpage: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Legacy comparison performs the same read/page/revisit operations against fixed responses.
    const { fetchWebPage } = await import('./web-search.js');
    const baseline = await fetchWebPage({ url: 'https://docs.example.org/spec' });
    await fetchWebPage({ url: 'https://docs.example.org/spec', cursor: baseline.nextCursor });
    await fetchWebPage({ url: 'https://docs.example.org/spec' });
    expect(fetcher).toHaveBeenCalledTimes(5); // New: 1 fetch; old: 3 fetches, same fixture.
  });
});
