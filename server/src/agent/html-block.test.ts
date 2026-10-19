import { describe, it, expect } from 'vitest';
import { validateReplyBlock, projectBlocks } from './content-blocks.js';
import { DEFAULT_HTML_CDN, htmlBlockPrompt, HTML_SOURCE_LIMIT, normalizeCdnEntry, validateHtmlSource } from './html-block.js';
const policy = { enabled: true, cdn: DEFAULT_HTML_CDN };
const noImages = async () => { throw new Error('无权图片引用'); };
const page = '<button onclick="wwa.fillInput(\'选 A\')">A</button>';

describe('interactive html blocks', () => {
  it('accepts a self-contained page with alt text and clamps height to the allowed range', async () => {
    await expect(validateReplyBlock({ type: 'html', source: page, alt: '两个选项', title: '选择', height: 300 }, noImages, undefined, policy)).resolves.toMatchObject({ type: 'html', source: page, alt: '两个选项', height: 300 });
    for (const raw of [{ type: 'html', source: page }, { type: 'html', source: page, alt: 'x', height: 50 }, { type: 'html', source: page, alt: 'x', height: 5000 }, { type: 'html', source: page, alt: 'x', sandbox: 'allow-same-origin' }, { type: 'html', source: 'x'.repeat(HTML_SOURCE_LIMIT + 1), alt: 'x' }])
      await expect(validateReplyBlock(raw, noImages, undefined, policy)).rejects.toThrow();
  });
  it('is refused when the setting is off or no policy was loaded', async () => {
    await expect(validateReplyBlock({ type: 'html', source: page, alt: 'x' }, noImages)).rejects.toThrow();
    await expect(validateReplyBlock({ type: 'html', source: page, alt: 'x' }, noImages, undefined, { enabled: false, cdn: DEFAULT_HTML_CDN })).rejects.toThrow('关闭');
  });
  it('only lets pinned files from the allowlist load, and rejects navigation or prefetch tricks', () => {
    expect(() => validateHtmlSource('<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>', policy)).not.toThrow();
    expect(() => validateHtmlSource('<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/animate.css/4.1.1/animate.min.css">', policy)).not.toThrow();
    for (const source of [
      '<script src="https://evil.example/x.js"></script>',
      '<script src="https://cdn.jsdelivr.net/npm/chart.js/dist/chart.umd.min.js"></script>',
      '<script src="https://cdn.jsdelivr.net/npm/chart.js@latest"></script>',
      '<script src="//cdn.jsdelivr.net/npm/a@1.0.0/a.js"></script>',
      '<base href="https://evil.example/">',
      '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
      '<link rel="dns-prefetch" href="https://evil.example">',
      '<link rel="prefetch" href="https://cdn.jsdelivr.net/npm/a@1.0.0/a.js">',
    ]) expect(() => validateHtmlSource(source, policy), source).toThrow();
  });
  it('normalizes allowlist entries to bare https origins', () => {
    expect(normalizeCdnEntry('https://cdn.jsdelivr.net/')).toBe('https://cdn.jsdelivr.net');
    expect(normalizeCdnEntry('http://127.0.0.1:4100')).toBe('http://127.0.0.1:4100');
    for (const entry of ['http://cdn.example', 'https://cdn.example/npm', 'javascript:alert(1)', '*', 'https://*.example.com']) expect(normalizeCdnEntry(entry), entry).toBeNull();
  });
  it('tells the model the rules only when enabled, and projects html as readable source', () => {
    expect(htmlBlockPrompt(policy)).toContain('wwa.fillInput');
    expect(htmlBlockPrompt(policy)).toContain('https://unpkg.com');
    expect(htmlBlockPrompt({ enabled: false, cdn: [] })).not.toContain('fillInput');
    const projection = projectBlocks([{ id: '1', index: 0, type: 'html', status: 'ready', title: '选择', source: page, alt: '两个选项' }]);
    expect(projection).toContain('选择'); expect(projection).toContain('wwa.fillInput');
  });
});
