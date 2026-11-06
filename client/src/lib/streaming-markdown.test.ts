import type { Root } from 'mdast';
import { it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { holdIncompleteFences } from './streaming-markdown.js';
it('holds incomplete graphic fences while releasing closed fences before the reply ends', async () => {
  for (const fence of ['```', '~~~~']) {
    const content = `${fence}mermaid\nflowchart LR; A-->B\n${fence}\n\n${fence}svg\n<svg></svg>`;
    const processor = unified().use(remarkParse).use(holdIncompleteFences);
    const tree = await processor.run(processor.parse(content), { value: content });
    expect((tree as Root).children.filter(n => n.type === 'code').map(n => n.type === 'code' && n.lang)).toEqual(['mermaid', 'text']);
  }
});
