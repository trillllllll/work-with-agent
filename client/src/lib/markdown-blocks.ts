import type { Content, Root } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const parse = unified().use(remarkParse).use(remarkGfm);

export type MarkdownBlock = { from: number; to: number; render: boolean };

export function markdownBlocks(source: string): MarkdownBlock[] {
  const tree = parse.parse(source) as Root;
  const blocks: MarkdownBlock[] = [];
  for (const node of tree.children) {
    const range = lineRange(source, node);
    if (!range || range.to <= range.from || !source.slice(range.from, range.to).trim()) continue;
    const block = { ...range, render: renders(node) };
    const last = blocks[blocks.length - 1];
    if (last && block.from < last.to) {
      last.to = Math.max(last.to, block.to);
      last.render = last.render || block.render;
    } else blocks.push(block);
  }
  return blocks;
}

export function blockHoldsCaret(block: { from: number; to: number }, from: number, to: number) {
  return from < block.to && to >= block.from;
}

// A paragraph of only text draws the same words the editor already shows.
// Replacing it with a block widget sends a click on its lower half to the next line.
function renders(node: Content) {
  if (node.type !== 'paragraph') return true;
  return node.children.some((child) => child.type !== 'text' && child.type !== 'break');
}

function lineRange(source: string, node: Content): { from: number; to: number } | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start == null || end == null || end <= start) return null;
  return { from: lineStart(source, start), to: lineBoundary(source, end) };
}

function lineStart(source: string, index: number) {
  const newline = source.lastIndexOf('\n', Math.max(0, index - 1));
  return newline < 0 ? 0 : newline + 1;
}

function lineBoundary(source: string, index: number) {
  if (index >= source.length) return source.length;
  if (source[index] === '\n') return index + 1;
  const newline = source.indexOf('\n', index);
  return newline < 0 ? source.length : newline + 1;
}
