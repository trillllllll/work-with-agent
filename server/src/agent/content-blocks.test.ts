import { describe, it, expect } from 'vitest';
import { presentReplyParameters, presentReplySchema, projectBlocks, validateReplyBlock } from './content-blocks.js';
import { sanitizeSvg } from './svg-sanitize.js';
const deniedImages = async () => { throw new Error('无权图片引用'); };
describe('validated display blocks', () => {
  it('shares the model schema and runtime schema, rejects arbitrary option/functions/unknown keys', async () => {
    expect((presentReplyParameters.properties as any).blocks.items.anyOf.length).toBe(6);
    expect(presentReplySchema.safeParse({ blocks: [{ type: 'text', markdown: '可用' }] }).success).toBe(true);
    for (const raw of [{ type: 'text', markdown: 'x', id: 'override' }, { type: 'chart', spec: { kind: 'bar', formatter: 'alert(1)' } }, { type: 'image_search', url: 'https://invented.invalid/x.jpg' }]) await expect(validateReplyBlock(raw, deniedImages)).rejects.toThrow();
  });
  it('supports safe SVG shapes and local arrows, rejects active content and external URLs', () => {
    const safe = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><defs><marker id="arrow" markerWidth="6" markerHeight="6"><path d="M0 0 L6 3 L0 6" /></marker></defs><path d="M10 10 L100 10" marker-end="url(#arrow)"/><text x="10" y="50">中文</text></svg>';
    expect(sanitizeSvg(safe)).toContain('中文');
    expect(sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img"><title>图</title></svg>')).toContain('role="img"');
    expect(() => sanitizeSvg(String.raw`<svg><rect fill="u\72l(https\3a\2f\2f blocked-svg.invalid/x)"/></svg>`)).toThrow('SVG 包含不允许的属性：fill');
    expect(() => sanitizeSvg('<svg onload="alert(1)"/>')).toThrow('SVG 包含不允许的属性：onload');
    expect(() => sanitizeSvg('<svg role="javascript:alert(1)"/>')).toThrow('SVG 包含不允许的属性：role');
    expect(() => sanitizeSvg('<svg><path fill="url(https://bad.invalid)"/></svg>')).toThrow('SVG 包含不允许的属性：fill');
    for (const source of ['<svg><script>alert(1)</script></svg>', '<svg><foreignObject/></svg>', '<svg><image href="https://remote.invalid"/></svg>', '<!DOCTYPE svg><svg/>', '<svg><g></svg>']) expect(() => sanitizeSvg(source)).toThrow();
  });
  it('validates Mermaid syntax family/configuration and isolates missing image permissions', async () => {
    for (const source of ['flowchart LR; A-->B', 'sequenceDiagram\nA->>B: hi', 'stateDiagram-v2\n[*] --> Active', 'classDiagram\nclass Task']) await expect(validateReplyBlock({ type: 'mermaid', source }, deniedImages)).resolves.toHaveProperty('source', source);
    for (const source of ['%%{init:{}}%%\nflowchart LR;A-->B', 'flowchart LR;click A "javascript:alert(1)"', 'pie\n"X":3']) await expect(validateReplyBlock({ type: 'mermaid', source }, deniedImages)).rejects.toThrow();
    await expect(validateReplyBlock({ type: 'image_search', searchId: 'other-conversation', resultIds: ['made-up'] }, deniedImages)).rejects.toThrow('无权');
  });
  it('keeps projections readable with sources, simulated labels and incomplete text', () => {
    const projection = projectBlocks([{ id: '1', index: 0, type: 'text', status: 'error', markdown: '保留部分内容', error: '已停止' }, { id: '2', index: 1, type: 'image_search', status: 'ready', items: [{ id: 'img', url: 'https://example.com/image.png', thumbnail: 'https://example.com/thumb.png', title: '图片', sourceUrl: 'https://example.com/page', searchedAt: '2026-10-19T00:00:00Z' }] }]);
    expect(projection).toContain('保留部分内容'); expect(projection).toContain('未完成'); expect(projection).toContain('来源：https://example.com/page');
  });
});
