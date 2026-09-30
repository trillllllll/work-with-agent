import { describe, expect, it } from 'vitest';
import { blockHoldsCaret, markdownBlocks } from './markdown-blocks.js';

describe('markdownBlocks', () => {
  it('splits a heading, a paragraph, and a code fence onto whole lines', () => {
    const source = '# 标题\n\n正文\n\n```\nconst n = 1;\n```\n';
    expect(markdownBlocks(source)).toEqual([
      { from: 0, to: '# 标题\n'.length, render: true },
      { from: '# 标题\n\n'.length, to: '# 标题\n\n正文\n'.length, render: false },
      { from: '# 标题\n\n正文\n\n'.length, to: source.length, render: true },
    ]);
  });

  it('keeps an image paragraph as one block', () => {
    const source = '前文\n\n![](/api/tasks/a/images/b)\n';
    const blocks = markdownBlocks(source);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].render).toBe(false);
    expect(blocks[1].render).toBe(true);
    expect(source.slice(blocks[1].from, blocks[1].to)).toBe('![](/api/tasks/a/images/b)\n');
  });

  it('leaves a bare file url as editor text', () => {
    const source = 'file:///Users/byc/WorkSpace/AfterSend/.codex-visuals/im-code-logic-branch-graph.html\n\n\n\n';
    expect(markdownBlocks(source)).toEqual([{ from: 0, to: source.indexOf('\n') + 1, render: false }]);
    expect(markdownBlocks('看 **接口**\n')[0].render).toBe(true);
  });

  it('treats a caret on the block as editing it, and the position after it as outside', () => {
    const block = { from: 2, to: 8 };
    expect(blockHoldsCaret(block, 2, 2)).toBe(true);
    expect(blockHoldsCaret(block, 7, 7)).toBe(true);
    expect(blockHoldsCaret(block, 8, 8)).toBe(false);
    expect(blockHoldsCaret(block, 0, 3)).toBe(true);
  });
});
