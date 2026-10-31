import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { Slice, type Node as PMNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { safeDocumentLink } from '../../../server/src/domain/document-content.js';
import { documentEditorExtensions } from '../components/documents/RichDocumentEditor.js';
import { createEditorCore } from '../components/documents/editor-core.js';
import { AlignedTable, MaterialReferenceNode, RawMarkdownNode, TaskImageNode } from '../components/tasks/description-extensions.js';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { MARKDOWN_PASTE_LIMIT, looksLikeMarkdown, markdownPasteSlice, pasteTransaction } from './markdown-paste.js';

const documentSchema = getSchema(documentEditorExtensions());
const paste = (text: string) => markdownPasteSlice(text, documentSchema, { isAllowedLink: safeDocumentLink });
function nodes(slice: Slice) { const list: PMNode[] = []; slice.content.forEach((node) => list.push(node)); return list; }
function types(slice: Slice) { const found: string[] = []; slice.content.descendants((node) => { found.push(node.type.name); }); return found; }
function marks(slice: Slice) { const found: string[] = []; slice.content.descendants((node) => { for (const mark of node.marks) found.push(mark.type.name === 'link' ? `link:${mark.attrs.href}` : mark.type.name); }); return found; }

describe('Markdown paste into rich documents', () => {
  it('converts a typical assistant reply into document structure', () => {
    const slice = paste('## 会议结论\n\n- 第一项\n- 第二项\n\n**重点**：上线前回归\n\n```js\nconsole.log(1)\n```\n\n| 列A | 列B |\n| --- | :-: |\n| 1 | 2 |')!;
    expect(slice).not.toBeNull();
    expect(nodes(slice).map((node) => node.type.name)).toEqual(['heading', 'bulletList', 'paragraph', 'codeBlock', 'table']);
    const [heading, list, paragraph, code, table] = nodes(slice);
    expect(heading.attrs.level).toBe(2); expect(heading.textContent).toBe('会议结论');
    expect(list.childCount).toBe(2); expect(list.textContent).toBe('第一项第二项');
    expect(paragraph.textContent).toBe('重点：上线前回归'); expect(marks(slice)).toContain('bold');
    expect(code.attrs.language).toBe('js'); expect(code.textContent).toBe('console.log(1)');
    expect(table.childCount).toBe(2);
    const header = table.child(0);
    expect(header.child(0).type.name).toBe('tableHeader');
    expect(header.child(1).attrs.align).toBe('center');
    expect(table.textContent).toBe('列A列B12');
  });

  it('keeps ordered lists, task items, quotes, inline code, italics and safe links', () => {
    const slice = paste('3. 第三\n4. 第四\n\n- [x] 完成\n- [ ] 未完成\n\n> 引用 *斜体* 和 `code`\n\n[文档](https://example.com/a)')!;
    expect(nodes(slice).map((node) => node.type.name)).toEqual(['orderedList', 'taskList', 'blockquote', 'paragraph']);
    expect(nodes(slice)[0].attrs.start).toBe(3);
    expect(nodes(slice)[1].child(0).attrs.checked).toBe(true); expect(nodes(slice)[1].child(1).attrs.checked).toBe(false);
    expect(marks(slice)).toEqual(expect.arrayContaining(['italic', 'code', 'link:https://example.com/a']));
  });

  it('keeps the text of unsafe links, remote images and unsupported fragments', () => {
    const slice = paste('# 标题\n\n[危险](javascript:alert(1)) ![截图](https://img.example/x.png)\n\n<div>原样保留</div>')!;
    expect(slice).not.toBeNull();
    expect(slice.content.textBetween(0, slice.content.size, '\n')).toContain('危险');
    expect(marks(slice).some((mark) => mark.startsWith('link:javascript'))).toBe(false);
    expect(marks(slice)).toContain('link:https://img.example/x.png');
    expect(types(slice)).not.toContain('image');
    expect(slice.content.textBetween(0, slice.content.size, '\n')).toContain('<div>原样保留</div>');
  });

  it('turns material citations into material links', () => {
    const slice = paste('# 来源\n\n[支付方案](wwa-material:abc123)')!;
    expect(marks(slice)).toContain('link:wwa-material:abc123');
    expect(slice.content.textBetween(0, slice.content.size, '\n')).toContain('支付方案');
  });

  it('opens a leading or trailing paragraph so it joins the text around the cursor', () => {
    expect(paste('前文 [链接](https://example.com)')).toMatchObject({ openStart: 1, openEnd: 1 });
    expect(paste('# 标题\n\n后文')).toMatchObject({ openStart: 0, openEnd: 1 });
  });

  it('leaves plain prose and oversized text to the ordinary paste', () => {
    expect(paste('只是一句话。\n\n第二段也是普通文字。')).toBeNull();
    expect(looksLikeMarkdown('普通文字')).toBe(false);
    expect(looksLikeMarkdown('## 标题')).toBe(true);
    expect(paste(`# 大\n\n${'x'.repeat(MARKDOWN_PASTE_LIMIT)}`)).toBeNull();
  });
});

describe('Markdown paste into task descriptions', () => {
  const taskSchema = getSchema([
    ...createEditorCore({ horizontalRule: false }), AlignedTable.configure({ resizable: false }), TableRow, TableCell, TableHeader,
    TaskImageNode(() => 'task-1', { zoom: () => {} }), MaterialReferenceNode({ openMaterial: () => {} }), RawMarkdownNode({ editRaw: () => {} }),
  ]);
  const pasteTask = (text: string) => markdownPasteSlice(text, taskSchema);

  it('keeps lists, quotes, tables with alignment and code content that the old insertion dropped', () => {
    const list = pasteTask('- 第一项\n- 第二项')!;
    expect(nodes(list).map((node) => node.type.name)).toEqual(['bulletList']);
    const mixed = pasteTask('> 引用\n\n| A | B |\n| :-- | --: |\n| 1 | 2 |\n\n```ts\nconst answer = 42\n```')!;
    expect(nodes(mixed).map((node) => node.type.name)).toEqual(['blockquote', 'table', 'codeBlock']);
    expect(nodes(mixed)[1].attrs.alignments).toEqual(['left', 'right']);
    expect(nodes(mixed)[2].textContent).toBe('const answer = 42');
  });

  it('keeps raw fragments, task images and material citations as the description editor loads them', () => {
    const slice = pasteTask('# 来源\n\n[方案](wwa-material:abc123) ![图](https://img.example/a.png)\n\n<details>原样</details>')!;
    expect(types(slice)).toEqual(expect.arrayContaining(['heading', 'materialReference', 'image', 'rawMarkdown']));
  });

  it('places quotes, tables and code pasted inside a list after the list, where the description Markdown can keep them', () => {
    const list = taskSchema.nodeFromJSON({ type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一项' }] }] }] }] });
    const state = EditorState.create({ schema: taskSchema, doc: list, selection: TextSelection.create(list, 6) });
    const blocks = pasteTransaction(state, pasteTask('> 引用\n\n```ts\nx\n```')!, { nestOnlyListContent: true }).doc;
    expect(nodes(new Slice(blocks.content, 0, 0)).map((node) => node.type.name)).toEqual(['bulletList', 'blockquote', 'codeBlock']);
    const nested = pasteTransaction(state, pasteTask('- 子项甲\n- 子项乙')!, { nestOnlyListContent: true }).doc;
    expect(nested.childCount).toBe(1); expect(nested.textContent).toContain('子项甲');
  });
});
