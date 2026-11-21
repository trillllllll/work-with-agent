import type { Root } from 'mdast';
import { it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { visit } from 'unist-util-visit';
import { holdIncompleteFences } from './streaming-markdown.js';
import { revealMarkdownArrival } from './markdown-arrivals.js';
it('holds incomplete graphic fences while releasing closed fences before the reply ends', async () => {
  for (const fence of ['```', '~~~~']) {
    const content = `${fence}mermaid\nflowchart LR; A-->B\n${fence}\n\n${fence}svg\n<svg></svg>`;
    const processor = unified().use(remarkParse).use(holdIncompleteFences);
    const tree = await processor.run(processor.parse(content), { value: content });
    expect((tree as Root).children.filter(n => n.type === 'code').map(n => n.type === 'code' && n.lang)).toEqual(['mermaid', 'text']);
  }
});

it('reveals only appended prose, preserving earlier text, inline code and graphemes', () => {
  const history = '此前已有文字 ';
  const live = history + '**新增** hello 👩‍💻 `node`';
  const processor = unified().use(remarkParse).use(remarkRehype).use(revealMarkdownArrival, { from: history.length });
  const tree = processor.runSync(processor.parse(live));
  const arrived: string[] = [];
  const all: string[] = [];
  visit(tree, 'text', (node, _, parent) => {
    all.push(node.value);
    if (parent?.type === 'element' && parent.tagName === 'span') arrived.push(node.value);
  });
  expect(all.join('')).toBe(history + '新增 hello 👩‍💻 node');
  expect(arrived).toEqual(['新', '增', 'hello', '👩‍💻']);
});
