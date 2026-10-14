import type { JSONContent } from '@tiptap/core';
import type { Content, Root, RootContent } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { materialCitation, materialIdFromHref } from './material-citation.js';

const parser = unified().use(remarkParse).use(remarkGfm);
const materialScheme = 'wwa-material:';

export type DescriptionModel = {
  taskId: string;
  originalMarkdown: string;
  originalDoc: JSONContent;
};

/**
 * Markdown 适配层：description 永远是 Markdown 字符串。
 * 未修改的文档逐字返回原文；编辑后的文档只对支持语法做规范化，
 * 不支持的块保留为 rawMarkdown 原文片段，不静默丢弃任何文字。
 */
export function parseDescription(markdown: string, taskId: string): {
  model: DescriptionModel;
  doc: JSONContent;
} {
  const tree = parser.parse(markdown) as Root;
  const content: JSONContent[] = [];
  for (const node of tree.children) {
    const converted = convertBlock(node, markdown);
    content.push(converted ?? rawMarkdownNode(node, markdown));
  }
  const doc: JSONContent = { type: 'doc', content };
  return { model: { taskId, originalMarkdown: markdown, originalDoc: doc }, doc };
}

export function serializeDescription(model: DescriptionModel, doc: JSONContent): string {
  if (docsEqual(doc, model.originalDoc)) return model.originalMarkdown;
  const parts: string[] = [];
  for (const node of doc.content ?? []) {
    if (node.type === 'rawMarkdown') {
      const raw = node.attrs?.markdown;
      if (typeof raw === 'string' && raw.trim()) parts.push(raw);
      continue;
    }
    const part = serializeBlock(node, '');
    if (part.trim()) parts.push(part);
  }
  return parts.join('\n\n');
}

// ---------- 文档比较 ----------

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === null || entry === undefined) continue;
      if (key === 'content' && Array.isArray(entry) && entry.length === 0) continue;
      out[key] = canonical(entry);
    }
    if ('marks' in out && Array.isArray(out.marks)) out.marks = [...out.marks].sort((a, b) => String((a as { type?: string }).type).localeCompare(String((b as { type?: string }).type)));
    return out;
  }
  return value;
}

/** 比较文档内容时排除临时视图状态、选区、上传装饰和仅用于渲染的 ID。 */
export function docsEqual(a: JSONContent, b: JSONContent): boolean {
  return JSON.stringify(canonical(stripTransient(a))) === JSON.stringify(canonical(stripTransient(b)));
}

function stripTransient(node: JSONContent): JSONContent {
  if (!node.attrs) return node;
  const attrs = { ...node.attrs };
  let changed = false;
  for (const key of Object.keys(attrs)) {
    // 上传装饰、渲染 ID 等运行时字段不属于正文内容。
    if (key === 'uploadId' || key === 'renderId') {
      delete attrs[key];
      changed = true;
    }
  }
  return changed ? { ...node, attrs } : node;
}

// ---------- 解析：mdast -> Tiptap 文档 ----------

function rawMarkdownNode(node: RootContent, source: string): JSONContent {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  const text = start != null && end != null ? source.slice(lineStart(source, start), lineEnd(source, end)) : '';
  return { type: 'rawMarkdown', attrs: { markdown: text.replace(/\n$/, '') } };
}

function lineStart(source: string, index: number) {
  const newline = source.lastIndexOf('\n', Math.max(0, index - 1));
  return newline < 0 ? 0 : newline + 1;
}

function lineEnd(source: string, index: number) {
  if (index >= source.length) return source.length;
  if (source[index] === '\n') return index + 1;
  const newline = source.indexOf('\n', index);
  return newline < 0 ? source.length : newline + 1;
}

function convertBlock(node: Content, source: string): JSONContent | null {
  switch (node.type) {
    case 'paragraph': {
      const inline = convertInline(node.children, false);
      return inline && { type: 'paragraph', content: inline };
    }
    case 'heading': {
      const inline = convertInline(node.children, true);
      return inline && { type: 'heading', attrs: { level: Math.min(6, Math.max(1, node.depth)) }, content: inline };
    }
    case 'code': {
      // 缩进代码块没有围栏，保留为原文片段，避免规范化时丢失缩进。
      const offset = node.position?.start.offset ?? 0;
      if (!/^(```|~~~)/.test(source.slice(offset, offset + 3))) return null;
      const attrs = node.lang ? { language: node.lang } : {};
      // 编辑器 JSON 使用 content 数组形态承载代码文字。
      return { type: 'codeBlock', attrs, content: node.value ? [{ type: 'text', text: node.value }] : [] };
    }
    case 'blockquote': {
      const content: JSONContent[] = [];
      for (const child of node.children) {
        const converted = convertBlock(child, source);
        if (!converted) return null;
        content.push(converted);
      }
      return { type: 'blockquote', content };
    }
    case 'list':
      return convertList(node);
    case 'table':
      return convertTable(node);
    default:
      return null;
  }
}

function convertList(node: Extract<Content, { type: 'list' }>): JSONContent | null {
  const items = node.children;
  if (!items.length) return null;
  const tasked = items.filter((item) => typeof item.checked === 'boolean');
  // 有序任务列表不是 GFM 语法；混合勾选与普通项的列表也保留原文。
  if (node.ordered && tasked.length) return null;
  const mixed = tasked.length > 0 && tasked.length < items.length;
  if (mixed) return null;
  const isTask = !node.ordered && tasked.length === items.length;

  const content: JSONContent[] = [];
  for (const item of items) {
    let paragraphs = 0;
    const inline: JSONContent[] = [];
    const nested: JSONContent[] = [];
    for (const child of item.children) {
      if (child.type === 'paragraph') {
        paragraphs += 1;
        if (paragraphs > 1) return null;
        const converted = convertInline(child.children, false);
        if (!converted) return null;
        inline.push(...converted);
      } else if (child.type === 'list') {
        const converted = convertList(child);
        if (!converted) return null;
        nested.push(converted);
      } else return null;
    }
    if (!inline.length) return null;
    const itemContent: JSONContent[] = [{ type: 'paragraph', content: inline }];
    itemContent.push(...nested);
    if (isTask) content.push({ type: 'taskItem', attrs: { checked: item.checked === true }, content: itemContent });
    else content.push({ type: 'listItem', content: itemContent });
  }
  if (isTask) return { type: 'taskList', content };
  if (node.ordered) return { type: 'orderedList', attrs: { start: Math.max(1, node.start ?? 1) }, content };
  return { type: 'bulletList', content };
}

function convertTable(node: Extract<Content, { type: 'table' }>): JSONContent | null {
  const alignments = (node.align ?? []).map((value) => value ?? null);
  const rows: JSONContent[] = [];
  for (const [rowIndex, row] of node.children.entries()) {
    const cells: JSONContent[] = [];
    for (const cell of row.children) {
      const inline = convertInline(cell.children, false);
      if (!inline) return null;
      const type = rowIndex === 0 ? 'tableHeader' : 'tableCell';
      cells.push({ type, content: [{ type: 'paragraph', content: inline }] });
    }
    rows.push({ type: 'tableRow', content: cells });
  }
  return { type: 'table', attrs: { alignments }, content: rows };
}

function convertInline(nodes: readonly Content[], inContainer: boolean): JSONContent[] | null {
  const out: JSONContent[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push({ type: 'text', text: node.value });
        break;
      case 'inlineCode':
        out.push({ type: 'text', text: node.value, marks: [{ type: 'code' }] });
        break;
      case 'break':
        out.push({ type: 'hardBreak' });
        break;
      case 'strong':
      case 'emphasis':
      case 'delete': {
        const inner = convertInline(node.children, true);
        if (!inner) return null;
        const mark = { type: node.type === 'strong' ? 'bold' : node.type === 'emphasis' ? 'italic' : 'strike' };
        out.push(...inner.map((child) => applyMark(child, mark)));
        break;
      }
      case 'image': {
        if (inContainer) return null;
        out.push({ type: 'image', attrs: { src: node.url, alt: node.alt ?? '', ...(node.title != null ? { title: node.title } : {}) } });
        break;
      }
      case 'link': {
        if (node.url.startsWith(materialScheme)) {
          const materialId = materialIdFromHref(node.url);
          if (!materialId) return null;
          if (!node.children.every((child) => child.type === 'text')) return null;
          const label = node.children.map((child) => (child.type === 'text' ? child.value : '')).join('');
          out.push({ type: 'materialReference', attrs: { materialId, label } });
        } else {
          const inner = convertInline(node.children, true);
          if (!inner) return null;
          const mark = { type: 'link', attrs: { href: node.url, ...(node.title != null ? { title: node.title } : {}) } };
          out.push(...inner.map((child) => applyMark(child, mark)));
        }
        break;
      }
      default:
        return null;
    }
  }
  return out.length ? out : [{ type: 'text', text: '' }];
}

function applyMark(node: JSONContent, mark: { type: string; attrs?: Record<string, unknown> }): JSONContent {
  if (node.type === 'text') return { ...node, marks: [...(node.marks ?? []), mark] };
  return node;
}

// ---------- 序列化：Tiptap 文档 -> Markdown ----------

function serializeBlock(node: JSONContent, indent: string): string {
  switch (node.type) {
    case 'paragraph':
      return serializeInline(node.content, { indent });
    case 'heading':
      return `${'#'.repeat(clampLevel(node.attrs?.level))} ${serializeInline(node.content, { indent })}`;
    case 'codeBlock': {
      const text = codeBlockText(node);
      const language = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
      const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
      // CommonMark 会剥掉闭合围栏前的最后一个换行；补足与不补，重解析结果都一致。
      const tail = text.endsWith('\n') ? '' : '\n';
      return `${fence}${language}\n${text}${tail}${fence}`;
    }
    case 'blockquote': {
      const inner = (node.content ?? []).map((child) => serializeBlock(child, indent)).filter((part) => part.trim());
      return inner.join('\n\n').split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
    }
    case 'bulletList':
      return serializeListItems(node.content, { marker: () => '- ', indent });
    case 'orderedList': {
      const start = typeof node.attrs?.start === 'number' && Number.isFinite(node.attrs.start) ? Math.max(1, Math.trunc(node.attrs.start)) : 1;
      return serializeListItems(node.content, { marker: (index) => `${start + index}. `, indent });
    }
    case 'taskList':
      return serializeListItems(node.content, { marker: (_index, checked) => `- [${checked ? 'x' : ' '}] `, indent });
    case 'table':
      return serializeTable(node);
    default:
      return '';
  }
}

type ListContext = { marker: (index: number, checked?: boolean) => string; indent: string };

function serializeListItems(items: readonly JSONContent[] | undefined, context: ListContext): string {
  const lines: string[] = [];
  (items ?? []).forEach((item, index) => {
    const checked = item.type === 'taskItem' ? item.attrs?.checked === true : undefined;
    const marker = context.marker(index, checked);
    const children = item.content ?? [];
    const paragraph = children.find((child) => child.type === 'paragraph');
    lines.push(`${context.indent}${marker}${serializeInline(paragraph?.content, { indent: '' })}`);
    const nestedIndent = `${context.indent}${' '.repeat(marker.length)}`;
    for (const child of children) {
      if (child.type === 'bulletList' || child.type === 'orderedList' || child.type === 'taskList') {
        const nested = serializeBlock(child, nestedIndent);
        if (nested.trim()) lines.push(nested);
      } else if (child.type === 'rawMarkdown') {
        const raw = child.attrs?.markdown;
        if (typeof raw === 'string' && raw.trim()) lines.push(`${nestedIndent}${raw}`);
      }
    }
  });
  return lines.join('\n');
}

function serializeTable(node: JSONContent): string {
  const rows = node.content ?? [];
  if (!rows.length) return '';
  const alignments = Array.isArray(node.attrs?.alignments) ? (node.attrs!.alignments as Array<'left' | 'center' | 'right' | null>) : [];
  const width = Math.max(...rows.map((row) => (row.content ?? []).length), alignments.length);
  const cellText = (cell: JSONContent | undefined): string => {
    if (!cell) return '';
    const paragraph = (cell.content ?? []).find((child) => child.type === 'paragraph');
    return serializeInline(paragraph?.content, { indent: '', inTable: true });
  };
  const renderRow = (row: JSONContent): string => {
    const cells: string[] = [];
    for (let index = 0; index < width; index += 1) cells.push(cellText((row.content ?? [])[index]));
    return `| ${cells.join(' | ')} |`;
  };
  const renderDelimiter = (): string => {
    const cells: string[] = [];
    for (let index = 0; index < width; index += 1) {
      const align = alignments[index];
      cells.push(align === 'left' ? ':---' : align === 'right' ? '---:' : align === 'center' ? ':---:' : '---');
    }
    return `| ${cells.join(' | ')} |`;
  };
  const out = [renderRow(rows[0]), renderDelimiter()];
  for (const row of rows.slice(1)) out.push(renderRow(row));
  return out.join('\n');
}

type InlineContext = { indent: string; inTable?: boolean };

function serializeInline(nodes: readonly JSONContent[] | undefined, context: InlineContext): string {
  let out = '';
  let atLineStart = true;
  for (const node of nodes ?? []) {
    if (node.type === 'text') {
      const text = typeof node.text === 'string' ? node.text : '';
      const marks = [...(node.marks ?? [])].sort((a, b) => markOrder(a.type) - markOrder(b.type));
      if (marks.some((mark) => mark.type === 'code')) {
        out += codeSpan(text);
      } else {
        let piece = escapeText(text, { atLineStart, inTable: context.inTable === true });
        for (const mark of marks) {
          if (mark.type === 'bold') piece = `**${piece}**`;
          else if (mark.type === 'italic') piece = `*${piece}*`;
          else if (mark.type === 'strike') piece = `~~${piece}~~`;
          else if (mark.type === 'link') {
            const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : '';
            const title = typeof mark.attrs?.title === 'string' ? ` "${mark.attrs.title.replace(/"/g, '\\"')}"` : '';
            piece = `[${piece}](${escapeUrl(href)}${title})`;
          }
        }
        out += piece;
      }
    } else if (node.type === 'hardBreak') {
      out += '  \n';
    } else if (node.type === 'image') {
      out += serializeImage(node);
    } else if (node.type === 'materialReference') {
      out += materialCitation(typeof node.attrs?.materialId === 'string' ? node.attrs.materialId : '', typeof node.attrs?.label === 'string' ? node.attrs.label : '');
    }
    atLineStart = node.type === 'hardBreak';
  }
  return out;
}

/** 兼容 text 字段与 content 数组两种代码文字形态。 */
function codeBlockText(node: JSONContent): string {
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map((child) => (typeof child.text === 'string' ? child.text : '')).join('');
}

function markOrder(type: string): number {
  return ({ code: 0, bold: 1, italic: 2, strike: 3, link: 4 } as Record<string, number>)[type] ?? 5;
}

function codeSpan(text: string): string {
  const run = longestRun(text, '`');
  const fence = '`'.repeat(Math.max(1, run + 1));
  const padded = run > 0 || /^ | $/.test(text) ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

function serializeImage(node: JSONContent): string {
  const src = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
  const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
  const title = typeof node.attrs?.title === 'string' ? ` "${node.attrs.title.replace(/"/g, '\\"')}"` : '';
  return `![${alt.replace(/\\/g, '\\\\').replace(/[[\]]/g, (ch) => `\\${ch}`)}](${escapeUrl(src)}${title})`;
}

function longestRun(text: string, ch: string): number {
  let longest = 0;
  let current = 0;
  for (const item of text) {
    if (item === ch) {
      current += 1;
      longest = Math.max(longest, current);
    } else current = 0;
  }
  return longest;
}

function escapeText(text: string, options: { atLineStart: boolean; inTable: boolean }): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    const atLineStart = options.atLineStart && index === 0;
    if ('\\`*~[]<>_'.includes(ch)) out += `\\${ch}`;
    else if (ch === '!' && text[index + 1] === '[') out += '\\!';
    else if (options.inTable && ch === '|') out += '\\|';
    else if (atLineStart && '#>+-='.includes(ch)) out += `\\${ch}`;
    else if (atLineStart && /[0-9]/.test(ch)) {
      const match = text.slice(index).match(/^[0-9]+[.)]/);
      out += match ? `\\${ch}` : ch;
    } else out += ch;
  }
  return out;
}

function escapeUrl(url: string): string {
  return url.replace(/\\/g, '%5C').replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function clampLevel(level: unknown): number {
  const value = typeof level === 'number' ? Math.trunc(level) : 1;
  return Math.min(6, Math.max(1, value));
}
