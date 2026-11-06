import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownView } from './MarkdownView.js';

const table = '| 工作类型 | 例子 | 接管度 | 你来决定 |\n| --- | --- | --- | --- |\n| **调查** | [工单](https://example.com/ticket) | `高` | 验收 |';
describe('responsive chat tables', () => {
  it('keeps rich headings, links and code in the stacked representation', () => {
    const html = renderToStaticMarkup(<MarkdownView content={table} responsiveTables />);
    expect(html).toContain('data-stackable="true"');
    const stacked = html.slice(html.indexOf('class="markdown-table-rows"'));
    expect(stacked).toMatch(/<h4><strong[^>]*>调查<\/strong><\/h4>/);
    expect(stacked).toContain('href="https://example.com/ticket"');
    expect(stacked).toContain('<dt>例子</dt>');
    expect(stacked).toContain('>高</code>');
    expect(stacked).toContain('<dt>你来决定</dt><dd>验收</dd>');
  });
  it('leaves other Markdown surfaces and incomplete or two-column headers as tables', () => {
    expect(renderToStaticMarkup(<MarkdownView content={table} />)).not.toContain('markdown-table-rows');
    for (const content of ['| 名称 | 值 |\n| --- | --- |\n| 日期 | 今天 |', '| | 例子 | 接管度 |\n| --- | --- | --- |\n| 调查 | 工单 | 高 |']) {
      const html = renderToStaticMarkup(<MarkdownView content={content} responsiveTables />);
      expect(html).toContain('<table');
      expect(html).not.toContain('markdown-table-rows');
    }
  });
});
