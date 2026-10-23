import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeProvider } from 'next-themes';
import { describe, expect, it } from 'vitest';
import { MarkdownView } from './MarkdownView.js';

const sample = '```mermaid\nflowchart TD\n  A[开始] --> B[结束]\n```\n\n```ts\nconst keep = 1\n```';

function html(diagrams: boolean) {
  return renderToStaticMarkup(
    <ThemeProvider attribute="class" defaultTheme="light">
      <MarkdownView content={sample} diagrams={diagrams} />
    </ThemeProvider>,
  );
}

describe('chat markdown diagrams', () => {
  it('previews SVG fences only in diagram-enabled code blocks, including unlabelled history', () => {
    const svg = '<svg viewBox="0 0 100 40"><text x="8" y="24">完成记录</text></svg>';
    for (const language of ['svg', 'SVG', 'xml', 'html', '']) {
      const content = '```' + language + '\n' + svg + '\n```';
      const preview = renderToStaticMarkup(<MarkdownView content={content} diagrams />);
      expect(preview).toContain('data-svg-block');
      expect(preview).not.toContain('<pre');
      const plain = renderToStaticMarkup(<MarkdownView content={content} />);
      expect(plain).not.toContain('data-svg-block');
      expect(plain).toContain('&lt;svg');
    }
    expect(renderToStaticMarkup(<MarkdownView content={'`' + svg + '`'} diagrams />)).not.toContain('data-svg-block');
    expect(renderToStaticMarkup(<MarkdownView content={'```ts\n' + svg + '\n```'} diagrams />)).not.toContain('data-svg-block');
  });

  it('turns a mermaid fence into a diagram and leaves other code as code', () => {
    const rendered = html(true);
    expect(rendered).toContain('data-mermaid-block');
    expect(rendered).toContain('源码');
    expect(rendered).toContain('const keep = 1');
    expect(rendered).not.toContain('data-mermaid-block">const keep');
    const without = html(false);
    expect(without).not.toContain('data-mermaid-block');
    expect(without).toContain('flowchart TD');
    expect(without).toContain('const keep = 1');
  });
});

describe('markdown typography override', () => {
  it('replaces the default typography classes when a className is given, keeping structural ones', () => {
    const overridden = renderToStaticMarkup(
      <ThemeProvider attribute="class" defaultTheme="light">
        <MarkdownView content="hi" className="text-sm" />
      </ThemeProvider>,
    );
    expect(overridden).toContain('markdown-body');
    expect(overridden).toContain('text-sm');
    expect(overridden).not.toContain('text-[13.5px]');
    expect(html(false)).toContain('text-[13.5px]');
  });
});
