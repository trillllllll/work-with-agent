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
