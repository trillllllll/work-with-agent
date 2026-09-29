import type { Content, Root } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const parse = unified().use(remarkParse).use(remarkGfm);

export type MarkdownBlock = { from: number; to: number };

export function markdownBlocks(source: string): MarkdownBlock[] {
  const tree = parse.parse(source) as Root;
  const blocks: MarkdownBlock[] = [];
  for (const node of tree.children) {
    const range = lineRange(source, node);
    if (!range || range.to <= range.from || !source.slice(range.from, range.to).trim()) continue;
    const last = blocks[blocks.length - 1];
    if (last && range.from < last.to) last.to = Math.max(last.to, range.to);
    else blocks.push(range);
  }
  return blocks;
}

export function blockHoldsCaret(block: MarkdownBlock, from: number, to: number) {
  return from < block.to && to >= block.from;
}

function lineRange(source: string, node: Content): MarkdownBlock | null {
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
