import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWebPage, searchWeb, WEB_PAGE_CHARS, WEB_PAGE_MAX_CHARS } from './web-search.js';
describe('deepseek web search tool', () => {
  beforeEach(() => { process.env.DEEPSEEK_API_KEY = 'deepseek-test-key'; delete process.env.WEB_SEARCH_PROXY_URL; });
  afterEach(() => { vi.restoreAllMocks(); delete process.env.DEEPSEEK_API_KEY; delete process.env.WEB_SEARCH_PROXY_URL; });
  it('maps search results, filters non-http URLs, and slices to count', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ results: [
      { title: 'sqlite3 — 官方文档', url: 'https://docs.python.org/3/library/sqlite3.html', snippet: 'DB-API 2.0 interface', summary: 'SQLite 数据库接口说明', date: '2026-01-01T00:00:00Z', site_name: 'Python docs', authority: 4, rerank_score: 2.5 },
      { title: '拒绝这个', url: 'ftp://example.com/file', authority: 1 },
      { title: '没有协议的', url: 'not-a-url' },
    ] }));
    const result = await searchWeb({ query: 'python sqlite3', count: 5 });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://api.deepseek.com/v1/tools/search');
    expect(options!).toMatchObject({ method: 'post', headers: { Authorization: 'Bearer deepseek-test-key' } });
    expect(JSON.parse(String(options!.body))).toEqual({ query: 'python sqlite3', count: 5, need_content: false });
    expect(result).toMatchObject({ provider: 'deepseek', query: 'python sqlite3', resultCount: 1 });
    expect(result.results[0]).toMatchObject({ url: 'https://docs.python.org/3/library/sqlite3.html', authority: 4, rerankScore: 2.5, siteName: 'Python docs' });
  });
  it('returns empty results without error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ results: [] }));
    const result = await searchWeb({ query: '不存在的主题' });
    expect(result).toMatchObject({ provider: 'deepseek', resultCount: 0, results: [] });
  });
  it('rejects queries over 128 characters and URLs with credentials', () => {
    expect(searchWeb({ query: 'x'.repeat(129) })).rejects.toThrow();
    expect(fetchWebPage({ url: 'https://user:pass@example.com/page' })).rejects.toThrow();
    expect(fetchWebPage({ url: 'javascript:alert(1)' })).rejects.toThrow();
  });
  it('paginates fetched pages by cursor', async () => {
    const content = 'a'.repeat(WEB_PAGE_CHARS + 500);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ title: '官方页面', content }))));
    const first = await fetchWebPage({ url: 'https://docs.example.com/guide' });
    expect(first).toMatchObject({ url: 'https://docs.example.com/guide', title: '官方页面', totalChars: content.length, truncated: true });
    expect(first.content).toHaveLength(WEB_PAGE_CHARS);
    expect(typeof first.nextCursor).toBe('string');
    expect(JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')).offset).toBe(WEB_PAGE_CHARS);
    expect(fetcher.mock.calls).toHaveLength(1);
    const second = await fetchWebPage({ url: 'https://docs.example.com/guide', cursor: first.nextCursor! });
    expect(second.content).toHaveLength(500);
    expect(second.truncated).toBe(false);
    expect(second.nextCursor).toBeNull();
  });
  it('caps very long pages at the 60000-character limit with a note', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ title: '长文', content: 'b'.repeat(WEB_PAGE_MAX_CHARS + 5000) }))));
    let cursor: string | null = null;
    let last: Awaited<ReturnType<typeof fetchWebPage>> | null = null;
    do {
      last = await fetchWebPage({ url: 'https://docs.example.com/long', ...(cursor ? { cursor } : {}) });
      cursor = last.nextCursor;
    } while (cursor);
    expect(last!.content).toHaveLength(WEB_PAGE_CHARS);
    expect(last!.totalChars).toBe(WEB_PAGE_MAX_CHARS + 5000);
    expect(last!.truncated).toBe(true);
    expect(last!.note).toContain('60000');
  });
  it('maps provider errors to controlled codes', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ title: null, content: null }), { status: 404 }));
    await expect(fetchWebPage({ url: 'https://docs.example.com/empty' })).rejects.toMatchObject({ code: 'WEB_SEARCH_UNAVAILABLE' });
    fetcher.mockResolvedValueOnce(new Response('', { status: 403 }));
    await expect(fetchWebPage({ url: 'https://docs.example.com/denied' })).rejects.toThrow('拒绝访问');
    fetcher.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    await expect(fetchWebPage({ url: 'https://docs.example.com/slow' })).rejects.toMatchObject({ code: 'WEB_SEARCH_UNAVAILABLE' });
  });
  it('rejects stale or out-of-range cursors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ title: '页面', content: '短正文' }));
    await expect(fetchWebPage({ url: 'https://docs.example.com/x', cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: 'CURSOR_STALE' });
    const beyond = Buffer.from(JSON.stringify({ offset: 99999 })).toString('base64url');
    await expect(fetchWebPage({ url: 'https://docs.example.com/x', cursor: beyond })).rejects.toMatchObject({ code: 'CURSOR_STALE' });
  });
});
