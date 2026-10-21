import { askAssistant } from '@/lib/assistant-context.js';
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { t as translate } from '../../i18n/index.js';
import { createPortal } from 'react-dom';
import { Editor, type Extensions, type JSONContent } from '@tiptap/core';
import { NodeSelection, type EditorState } from '@tiptap/pm/state';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { EditorContent, useEditor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Link } from '@tiptap/extension-link';
import { Placeholder } from '@tiptap/extension-placeholder';
import { ListKit } from '@tiptap/extension-list';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Bold, Code, Italic, Link2, List, ListOrdered, ListTodo, MoreHorizontal, Quote, Strikethrough } from 'lucide-react';
import { parseDescription, serializeDescription, type DescriptionModel } from '@/lib/description-codec.js';
import type { EditorSelectionBookmark } from '@/lib/task-editor-types.js';
import { AlignedTable, findUploadPosition, MaterialReferenceNode, RawMarkdownNode, TaskImageNode, TaskItemPointerSync, taskImageContent, uploadKey, UploadDecorations } from './description-extensions.js';
import { Button } from '@/components/ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import { cn } from '@/lib/utils.js';

export type DescriptionHandle = {
  focus: () => void;
  blur: () => void;
  insertImages: (urls: string[]) => void;
  addUpload: (uploadId: string, fileName: string) => void;
  hasUpload: (uploadId: string) => boolean;
  resolveUpload: (uploadId: string, src: string) => boolean;
  removeUpload: (uploadId: string) => void;
  bookmark: () => EditorSelectionBookmark | null;
  insertMaterialReferences: (references: { materialId: string; label: string }[], range?: { from: number; to: number }) => string | null;
};

// 每个任务只有一个活动编辑器；离开详情后的上传回执按任务定位。
const activeEditors = new Map<string, Editor>();
export function taskEditor(taskId: string) {
  return activeEditors.get(taskId) ?? null;
}

/** 上传完成后把图片插回捕获任务的映射位置；装饰不存在或已取消时返回 false。 */
export function resolveTaskUploadOnEditor(taskId: string, uploadId: string, src: string): boolean {
  const editor = activeEditors.get(taskId);
  if (!editor || editor.isDestroyed) return false;
  const decorations = uploadKey.getState(editor.state)?.decorations;
  if (!decorations || findUploadPosition(decorations, uploadId) == null) return false;
  const pos = findUploadPosition(decorations, uploadId)!;
  const plan = taskImageContent(editor.state.doc, pos, src, editor.schema.nodes.image);
  editor.chain()
    .insertContentAt(plan.at, plan.content)
    .command(({ tr, dispatch }) => {
      if (dispatch) tr.setMeta(uploadKey, { type: 'remove', uploadId });
      return true;
    })
    .run();
  return true;
}

/** 移除上传装饰（取消或失败）。 */
export function removeTaskUploadFromEditor(taskId: string, uploadId: string) {
  const editor = activeEditors.get(taskId);
  if (!editor || editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(uploadKey, { type: 'remove', uploadId }));
}

/** 读取当前任务编辑器的选区 bookmark；包含文档长度用于位置有效性校验。 */
export function readTaskBookmark(taskId: string): (EditorSelectionBookmark & { docSize: number }) | null {
  const editor = activeEditors.get(taskId);
  if (!editor || editor.isDestroyed) return null;
  const selection = editor.state.selection;
  return {
    taskId,
    anchor: selection.anchor,
    head: selection.head,
    docSize: editor.state.doc.content.size,
    kind: selection instanceof NodeSelection ? 'node' : 'text',
  };
}

/** 在当前任务的富文本文档上替换选区并插入资料引用，返回序列化后的完整正文。 */
export function insertMaterialReferencesIntoTask(taskId: string, references: { materialId: string; label: string }[], range: { from: number; to: number }): string | null {
  const editor = activeEditors.get(taskId);
  if (!editor || editor.isDestroyed || !references.length) return null;
  const size = editor.state.doc.content.size;
  const from = Math.max(0, Math.min(range.from, size));
  const to = Math.max(from, Math.min(range.to, size));
  // 一次编辑事务，保留可撤销性。
  editor.chain().focus()
    .insertContentAt({ from, to }, references.map((reference) => ({ type: 'materialReference', attrs: reference })))
    .run();
  return (editor.getJSON() as unknown) === null ? null : serializeCurrent(editor);
}

function serializeCurrent(editor: Editor): string | null {
  // 通过 onUpdate 序列化已在 dispatch 内完成；这里读取 DOM 上同步维护的值。
  const value = editor.view.dom.getAttribute('data-value');
  return value == null ? null : value;
}

export function readDescriptionCaret(node: HTMLElement | null) {
  if (!node) return null;
  for (const editor of activeEditors.values()) {
    if (editor.isDestroyed || !editor.view.dom.contains(node) && editor.view.dom !== node) continue;
    const selection = editor.state.selection;
    return { start: selection.from, end: selection.to };
  }
  return null;
}

export function placeDescriptionCaret(node: HTMLElement | null, start: number, end: number) {
  if (!node) return false;
  for (const editor of activeEditors.values()) {
    if (editor.isDestroyed || (editor.view.dom !== node && !editor.view.dom.contains(node))) continue;
    if (!editor.isEditable) return false;
    const length = editor.state.doc.content.size;
    const from = Math.max(0, Math.min(start, length));
    const to = Math.max(from, Math.min(end, length));
    editor.chain().focus().setTextSelection({ from, to }).run();
    return editor.view.hasFocus();
  }
  return false;
}

/** 代码块、行内代码和原文片段中禁用 Markdown 输入规则。 */
function guardMarkdownRules(extensions: Extensions): Extensions {
  for (const extension of extensions) {
    const holder = extension as unknown as { config?: { addInputRules?: (...args: unknown[]) => unknown[] } };
    const original = holder.config?.addInputRules;
    if (!holder.config || typeof original !== 'function') continue;
    holder.config.addInputRules = function (this: unknown, ...args: unknown[]) {
      const rules = (original.apply(this, args) ?? []) as Array<{ handler?: (state: EditorState, match: RegExpMatchArray, start: number, end: number) => unknown }>;
      return rules.map((rule) => {
        const handler = rule.handler;
        if (typeof handler !== 'function') return rule;
        return {
          ...rule,
          handler(state: EditorState, match: RegExpMatchArray, start: number, end: number) {
            const $from = state.doc.resolve(start);
            if ($from.parent.type.spec.code) return false;
            if ($from.marks().some((mark: { type: { name: string } }) => mark.type.name === 'code')) return false;
            return handler(state, match, start, end);
          },
        };
      });
    };
  }
  return extensions;
}

// 剪贴板文本是否包含完整、可识别的 Markdown 结构。
function looksLikeMarkdown(text: string) {
  const { doc } = parseDescription(text, 'clipboard');
  const structural = new Set(['heading', 'codeBlock', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'table', 'rawMarkdown']);
  let found = false;
  const visit = (node: JSONContent) => {
    if (typeof node.type === 'string' && structural.has(node.type)) found = true;
    for (const mark of node.marks ?? []) {
      if (mark.type === 'link' || mark.type === 'code') found = true;
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(doc);
  return found;
}

export function DescriptionEditor({ value, taskId, readonly, fill, openDescription, onEdit, onComposeStart, onComposeEnd, onPasteImages, onZoom, onOpenLinkedTask, ref }: {
  value: string;
  taskId: string;
  readonly: boolean;
  fill: boolean;
  openDescription: { current: () => void };
  onEdit: (description: string) => void;
  onComposeStart: () => void;
  onComposeEnd: () => void;
  onPasteImages: (files: File[]) => void;
  onZoom: (src: string) => void;
  onOpenLinkedTask?: (taskId: string) => void;
  ref?: Ref<DescriptionHandle>;
}) {
  const { i18n } = useTranslation('tasks');
  const [rawDialog, setRawDialog] = useState<{ pos: number; markdown: string } | null>(null);
  const modelRef = useRef<DescriptionModel | null>(null);
  const lastLocalRef = useRef(value);
  const composingRef = useRef(false);
  const plainPasteRef = useRef(false);
  const taskIdRef = useRef(taskId);
  const onEditRef = useRef(onEdit);
  const onPasteRef = useRef(onPasteImages);
  const onOpenLinkedTaskRef = useRef(onOpenLinkedTask);
  taskIdRef.current = taskId;
  onEditRef.current = onEdit;
  onPasteRef.current = onPasteImages;
  onOpenLinkedTaskRef.current = onOpenLinkedTask;

  const openMaterial = useCallback((materialId: string) => {
    window.dispatchEvent(new CustomEvent('wwa-preview-material', { detail: { taskId: taskIdRef.current, materialId } }));
  }, []);

  const editor = useEditor({
    extensions: guardMarkdownRules([
      StarterKit.configure({
        horizontalRule: false,
        underline: false,
        link: false,
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        // 列表只从 ListKit 注册一次。StarterKit 再带一份时，重复的 appendTransaction 会抛出 mismatched transaction。
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        protocols: ['http', 'https', 'mailto'],
        HTMLAttributes: { rel: 'noreferrer', target: '_blank' },
      }),
      ListKit.configure({ taskItem: { nested: true } }),
      Placeholder.configure({ placeholder: () => translate('tasks:descriptionEditor.addDetails'), showOnlyWhenEditable: true }),
      UploadDecorations,
      AlignedTable.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      TaskImageNode(() => taskIdRef.current, { zoom: (src) => onZoomRef.current(src) }),
      TaskItemPointerSync,
      MaterialReferenceNode({ openMaterial }),
      RawMarkdownNode({ editRaw: (pos, markdown) => setRawDialog({ pos, markdown }) }),
    ]),
    content: (() => {
      const parsed = parseDescription(value, taskId);
      modelRef.current = parsed.model;
      return parsed.doc;
    })(),
    editable: !readonly,
    enablePasteRules: true,
    editorProps: {
      attributes: { 'aria-label': translate('tasks:descriptionEditor.detailsLabel'), role: 'textbox', 'aria-multiline': 'true', class: 'task-prose', 'data-task-editor-prose': 'true' },
      handleKeyDown: (_view, event) => {
        // 粘贴为纯文本：Mod+Shift+V。
        if (event.key.toLowerCase() === 'v' && event.shiftKey && (event.metaKey || event.ctrlKey)) plainPasteRef.current = true;
        return false;
      },
      handlePaste: (view, event) => {
        if (readonly) return false;
        const clipboard = event.clipboardData;
        const images = [...(clipboard?.files ?? [])].filter((file) => file.type.startsWith('image/') && file.type !== 'image/svg+xml');
        if (images.length) {
          event.preventDefault();
          event.stopPropagation();
          onPasteRef.current(images);
          return true;
        }
        const plain = clipboard?.getData('text/plain') ?? '';
        const html = clipboard?.getData('text/html');
        if (plainPasteRef.current) {
          plainPasteRef.current = false;
          event.preventDefault();
          insertPlainText(view, plain);
          return true;
        }
        plainPasteRef.current = false;
        if (html) {
          // 交给 schema 白名单解析：脚本、事件属性与不支持嵌入会被丢弃；
          // 图片地址由 TaskImageNode 校验，只接受当前任务的图片。
          return false;
        }
        if (!plain) return false;
        event.preventDefault();
        if (looksLikeMarkdown(plain)) {
          const { doc } = parseDescription(plain, taskIdRef.current);
          insertPlainDoc(view, doc);
          return true;
        }
        insertPlainText(view, plain);
        return true;
      },
      handleDrop: (view, event, _drag, moved) => {
        if (readonly || moved) return false;
        const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith('image/') && file.type !== 'image/svg+xml');
        if (!files.length) return false;
        event.preventDefault();
        event.stopPropagation();
        onPasteRef.current(files);
        return true;
      },
    },
    onUpdate: ({ editor: current }) => {
      const model = modelRef.current;
      if (!model) return;
      const serialized = serializeDescription(model, current.getJSON());
      if (serialized === lastLocalRef.current) return;
      lastLocalRef.current = serialized;
      current.view.dom.setAttribute('data-value', serialized);
      onEditRef.current(serialized);
    },
  });

  const onZoomRef = useRef(onZoom);
  onZoomRef.current = onZoom;

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dom.setAttribute('aria-label', translate('tasks:descriptionEditor.detailsLabel'));
    editor.view.dispatch(editor.state.tr.setMeta('i18n', i18n.language));
  }, [editor, i18n.language]);

  useEffect(() => {
    if (!editor) return;
    activeEditors.set(taskId, editor);
    editor.view.dom.setAttribute('data-value', value);
    return () => {
      if (activeEditors.get(taskId) === editor) activeEditors.delete(taskId);
    };
  }, [editor, taskId]);

  useLayoutEffect(() => {
    if (!editor) return;
    editor.setEditable(!readonly);
  }, [editor, readonly]);

  // 外部值（冲突解决、远端合并、草稿恢复）到达时替换内容；本地编辑不回写。
  useLayoutEffect(() => {
    if (!editor) return;
    if (value === lastLocalRef.current) return;
    const parsed = parseDescription(value, taskId);
    modelRef.current = parsed.model;
    lastLocalRef.current = value;
    editor.commands.setContent(parsed.doc, { emitUpdate: false });
    editor.view.dom.setAttribute('data-value', value);
  }, [value, editor, taskId]);

  useImperativeHandle(ref, () => ({
    focus: () => editor?.commands.focus(),
    blur: () => editor?.view.dom.blur(),
    insertImages: (urls) => {
      if (!editor) return;
      const chain = editor.chain().focus();
      for (const url of urls) {
        const plan = taskImageContent(editor.state.doc, editor.state.selection.to, url, editor.schema.nodes.image);
        chain.insertContentAt(plan.at, plan.content);
      }
      chain.run();
    },
    addUpload: (uploadId, fileName) => {
      if (!editor || editor.isDestroyed) return;
      const pos = taskImageContent(editor.state.doc, editor.state.selection.to, '', editor.schema.nodes.image).at;
      editor.view.dispatch(editor.state.tr.setMeta(uploadKey, { type: 'add', uploadId, pos, fileName }));
    },
    hasUpload: (uploadId) => {
      if (!editor || editor.isDestroyed) return false;
      const decorations = uploadKey.getState(editor.state)?.decorations;
      return decorations ? findUploadPosition(decorations, uploadId) != null : false;
    },
    resolveUpload: (uploadId, src) => {
      if (!editor || editor.isDestroyed) return false;
      const decorations = uploadKey.getState(editor.state)?.decorations;
      const pos = decorations ? findUploadPosition(decorations, uploadId) : null;
      if (pos == null) return false;
      const plan = taskImageContent(editor.state.doc, pos, src, editor.schema.nodes.image);
      editor.chain()
        .insertContentAt(plan.at, plan.content)
        .command(({ tr, dispatch }) => {
          if (dispatch) tr.setMeta(uploadKey, { type: 'remove', uploadId });
          return true;
        })
        .run();
      return true;
    },
    removeUpload: (uploadId) => {
      if (!editor || editor.isDestroyed) return;
      editor.view.dispatch(editor.state.tr.setMeta(uploadKey, { type: 'remove', uploadId }));
    },
    bookmark: () => {
      if (!editor) return null;
      const selection = editor.state.selection;
      return { taskId, anchor: selection.anchor, head: selection.head, kind: selection instanceof NodeSelection ? 'node' : 'text' };
    },
    insertMaterialReferences: (references, range) => {
      if (!editor || !references.length) return null;
      const target = range ?? { from: editor.state.selection.from, to: editor.state.selection.to };
      const valid = Math.min(target.from, target.to);
      const end = Math.max(target.from, target.to);
      editor.chain().focus()
        .insertContentAt({ from: valid, to: end }, references.map((reference) => ({ type: 'materialReference', attrs: reference })))
        .run();
      const model = modelRef.current;
      if (!model) return null;
      const serialized = serializeDescription(model, editor.getJSON());
      lastLocalRef.current = serialized;
      editor.view.dom.setAttribute('data-value', serialized);
      return serialized;
    },
  }), [editor, taskId]);

  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onCompositionStart = () => {
      composingRef.current = true;
      onComposeStart();
    };
    const onCompositionEnd = () => {
      composingRef.current = false;
      // 下一轮事件循环读取最终文档并更新一次草稿。
      queueMicrotask(() => {
        if (editor.isDestroyed) return;
        const model = modelRef.current;
        if (!model) return;
        const serialized = serializeDescription(model, editor.getJSON());
        if (serialized !== lastLocalRef.current) {
          lastLocalRef.current = serialized;
          editor.view.dom.setAttribute('data-value', serialized);
          onEditRef.current(serialized);
        }
        onComposeEnd();
      });
    };
    dom.addEventListener('compositionstart', onCompositionStart);
    dom.addEventListener('compositionend', onCompositionEnd);
    const focus = () => editor.commands.focus();
    openDescription.current = focus;
    return () => {
      dom.removeEventListener('compositionstart', onCompositionStart);
      dom.removeEventListener('compositionend', onCompositionEnd);
      if (openDescription.current === focus) openDescription.current = () => {};
    };
  }, [editor, openDescription, onComposeStart, onComposeEnd]);

  const applyRawEdit = () => {
    if (!editor || !rawDialog) return;
    const node = editor.state.doc.nodeAt(rawDialog.pos);
    if (node?.type.name === 'rawMarkdown') {
      const from = rawDialog.pos;
      const to = rawDialog.pos + node.nodeSize;
      const replacement = parseDescription(`${rawDialog.markdown}\n`, taskId);
      const blocks = replacement.doc.content ?? [];
      const convertible = blocks.length >= 1 && blocks.every((block) => block.type !== 'rawMarkdown');
      if (convertible) {
        editor.chain().focus().insertContentAt({ from, to }, { type: 'doc', content: blocks }).run();
      } else {
        editor.chain().focus().command(({ tr, dispatch }) => {
          if (dispatch) tr.setNodeMarkup(from, undefined, { ...node.attrs, markdown: rawDialog.markdown });
          return true;
        }).run();
      }
    }
    setRawDialog(null);
    editor.commands.focus();
  };

  const { t } = useTranslation('tasks');
  return <div className={cn('task-description-editor', fill && 'task-description-grow')}>
    <EditorContent editor={editor} className="task-description-input w-full" />
    {editor && !readonly && <FormatToolbar editor={editor} composing={() => composingRef.current} taskId={taskId} />}
    {rawDialog && createPortal(<div className="task-raw-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setRawDialog(null); }}>
      <div className="task-raw-dialog" role="dialog" aria-label={t('descriptionEditor.editRawTitle')}>
        <p className="task-raw-dialog-title">{t('descriptionEditor.editRawTitle')}</p>
        <textarea className="task-raw-dialog-input" aria-label={t('descriptionEditor.rawContent')} value={rawDialog.markdown} onChange={(event) => setRawDialog({ ...rawDialog, markdown: event.target.value })} rows={8} />
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setRawDialog(null)}>{t('shared.cancel')}</Button>
          <Button size="sm" onClick={applyRawEdit}>{t('descriptionEditor.apply')}</Button>
        </div>
      </div>
    </div>, document.body)}
  </div>;
}

/** 把纯文本插入为普通文字；换行转换为硬换行，不触发 Markdown 格式识别。 */
function insertPlainText(view: EditorView, text: string) {
  const schema = view.state.schema;
  const nodes: PMNode[] = [];
  text.split('\n').forEach((line, index) => {
    if (index > 0) nodes.push(schema.nodes.hardBreak.create());
    if (line) nodes.push(schema.text(line));
  });
  const paragraph = schema.nodes.paragraph.create(null, nodes.length ? nodes : undefined);
  view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.fromArray([paragraph]), 0, 0)).scrollIntoView());
}

/** 通过适配层插入剪贴板里可识别的 Markdown 文档。 */
function insertPlainDoc(view: EditorView, doc: JSONContent) {
  const schema = view.state.schema;
  const nodes: PMNode[] = [];
  for (const block of doc.content ?? []) {
    if (block.type === 'paragraph') {
      const inline: PMNode[] = [];
      for (const child of block.content ?? []) {
        if (child.type === 'text') inline.push(schema.text(child.text ?? ''));
        else if (child.type === 'hardBreak') inline.push(schema.nodes.hardBreak.create());
        else if (child.type === 'image') inline.push(schema.nodes.image.create({ src: child.attrs?.src ?? '', alt: child.attrs?.alt ?? '' }));
      }
      nodes.push(schema.nodes.paragraph.create(null, inline.length ? inline : undefined));
    } else if (block.type === 'heading') {
      const inline: PMNode[] = (block.content ?? []).map((child) => schema.text(child.text ?? ''));
      nodes.push(schema.nodes.heading.create({ level: block.attrs?.level ?? 1 }, inline));
    } else if (block.type === 'codeBlock') {
      nodes.push(schema.nodes.codeBlock.create(block.attrs?.language ? { language: block.attrs.language } : null, block.text ? schema.text(block.text) : undefined));
    }
  }
  if (!nodes.length) return;
  view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.fromArray(nodes), 0, 0)).scrollIntoView());
}

type ToolbarProps = { editor: Editor; composing: () => boolean; taskId: string };

function FormatToolbar({ editor, composing, taskId }: ToolbarProps) {
  const { t } = useTranslation('tasks');
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<{ top: number; bottom: number; left: number } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkHref, setLinkHref] = useState('');
  const touch = useTouchInput();

  useEffect(() => {
    const update = () => {
      if (composing()) { setVisible(false); return; }
      const { from, to, empty } = editor.state.selection;
      if (empty || !editor.isEditable || !editor.view.hasFocus() && !document.activeElement?.closest('[data-format-tools]')) {
        setVisible(false);
        setLinkOpen(false);
        return;
      }
      try {
        const start = editor.view.coordsAtPos(from);
        const end = editor.view.coordsAtPos(to);
        const top = Math.min(start.top, end.top);
        const bottom = Math.max(start.bottom, end.bottom);
        const left = (start.left + end.left) / 2;
        setCoords({ top, bottom, left });
        setVisible(true);
      } catch {
        setVisible(false);
      }
    };
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    editor.on('focus', update);
    editor.on('blur', () => {
      window.setTimeout(() => {
        if (document.activeElement?.closest('[data-format-tools]')) return;
        setVisible(false);
      }, 80);
    });
    update();
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
      editor.off('focus', update);
    };
  }, [editor, composing]);

  if (!visible || !coords) return null;

  const buttonClass = touch ? 'task-format-button touch' : 'task-format-button';
  const run = (command: () => void) => {
    command();
    editor.view.focus();
  };
  const currentLink = editor.getAttributes('link').href as string | undefined;

  const bar = <div className="task-format-toolbar" data-format-tools role="toolbar" aria-label={t('descriptionEditor.format')} style={{ top: 0, left: 0 }} ref={(node) => {
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const margin = 8;
    // 选区上方放不下（顶到视口或压住标题）时放到选区下方，不遮挡标题，也不盖住选中的文字。
    const titleInput = node.ownerDocument.querySelector<HTMLElement>('[data-testid="task-detail-title-row"] textarea');
    const floor = Math.max(margin, titleInput ? titleInput.getBoundingClientRect().bottom : margin);
    let top = coords.top - rect.height - 8;
    if (top < floor) top = coords.bottom + 8;
    let left = coords.left - rect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin));
    node.style.top = `${top}px`;
    node.style.left = `${left}px`;
  }}>
    <button type="button" className={cn(buttonClass, 'task-format-ask')} aria-label={t('descriptionEditor.askAi')} onMouseDown={(event) => event.preventDefault()} onClick={() => { const { from, to } = editor.state.selection; askAssistant({ kind: 'selection', title: t('descriptionEditor.selectionTitle'), text: editor.state.doc.textBetween(from, to, '\n'), taskId, unsaved: true }); }}>{t('descriptionEditor.askAi')}</button>
    {touch ? <>
      <ToolbarButton className={buttonClass} label={t('descriptionEditor.bold')} icon={Bold} pressed={editor.isActive('bold')} onClick={() => run(() => editor.chain().focus().toggleBold().run())} />
      <ToolbarButton className={buttonClass} label={t('descriptionEditor.bulletList')} icon={List} pressed={editor.isActive('bulletList')} onClick={() => run(() => editor.chain().focus().toggleBulletList().run())} />
      <ToolbarButton className={buttonClass} label={t('descriptionEditor.checklist')} icon={ListTodo} pressed={editor.isActive('taskList')} onClick={() => run(() => editor.chain().focus().toggleTaskList().run())} />
      <Popover open={linkOpen} onOpenChange={setLinkOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={cn(buttonClass, 'task-format-more')} aria-label={t('descriptionEditor.moreFormats')} onMouseDown={(event) => event.preventDefault()}><MoreHorizontal className="size-4" aria-hidden /></button>
        </PopoverTrigger>
        <PopoverContent data-format-tools className="task-format-menu w-44" align="start">
          <MoreFormats editor={editor} onLink={() => { setLinkHref(currentLink ?? ''); setLinkOpen(true); }} />
        </PopoverContent>
      </Popover>
    </> : <>
      <ToolbarButton className={buttonClass} label={t('descriptionEditor.bold')} icon={Bold} pressed={editor.isActive('bold')} onClick={() => run(() => editor.chain().focus().toggleBold().run())} />
      <ToolbarButton className={buttonClass} label={t('descriptionEditor.italic')} icon={Italic} pressed={editor.isActive('italic')} onClick={() => run(() => editor.chain().focus().toggleItalic().run())} />
      <ToolbarButton className={buttonClass} label={t('descriptionEditor.strike')} icon={Strikethrough} pressed={editor.isActive('strike')} onClick={() => run(() => editor.chain().focus().toggleStrike().run())} />
      <ToolbarButton className={buttonClass} label={t('descriptionEditor.inlineCode')} icon={Code} pressed={editor.isActive('code')} onClick={() => run(() => editor.chain().focus().toggleCode().run())} />
      <button type="button" className={cn(buttonClass, editor.isActive('link') && 'is-active')} aria-label={t('descriptionEditor.link')} aria-pressed={editor.isActive('link')} title={t('descriptionEditor.link')}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => { setLinkHref(currentLink ?? ''); setLinkOpen(true); }}>
        <Link2 className="size-4" aria-hidden />
      </button>
      <Popover open={linkOpen} onOpenChange={setLinkOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={cn(buttonClass, 'task-format-more')} aria-label={t('descriptionEditor.moreFormats')} onMouseDown={(event) => event.preventDefault()}><MoreHorizontal className="size-4" aria-hidden /></button>
        </PopoverTrigger>
        <PopoverContent data-format-tools className="task-format-menu w-44" align="start">
          <MoreFormats editor={editor} onLink={() => { setLinkHref(currentLink ?? ''); setLinkOpen(true); }} />
        </PopoverContent>
      </Popover>
    </>}
  </div>;

  return createPortal(<>
    {bar}
    <LinkPopover editor={editor} open={linkOpen} setOpen={setLinkOpen} href={linkHref} setHref={setLinkHref} />
  </>, document.body);
}

function MoreFormats({ editor, onLink }: { editor: Editor; onLink: () => void }) {
  const { t } = useTranslation('tasks');
  const item = (label: string, active: boolean, run: () => void) => <button type="button" className={cn('task-format-menu-item', active && 'is-active')} aria-pressed={active} onClick={() => { run(); editor.view.focus(); }}>{label}</button>;
  return <div className="task-format-menu-list">
    {item(t('descriptionEditor.heading1'), editor.isActive('heading', { level: 1 }), () => editor.chain().focus().toggleHeading({ level: 1 }).run())}
    {item(t('descriptionEditor.heading2'), editor.isActive('heading', { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run())}
    {item(t('descriptionEditor.heading3'), editor.isActive('heading', { level: 3 }), () => editor.chain().focus().toggleHeading({ level: 3 }).run())}
    {item(t('descriptionEditor.bulletList'), editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run())}
    {item(t('descriptionEditor.orderedList'), editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run())}
    {item(t('descriptionEditor.checklist'), editor.isActive('taskList'), () => editor.chain().focus().toggleTaskList().run())}
    {item(t('descriptionEditor.quote'), editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run())}
    {item(t('descriptionEditor.codeBlock'), editor.isActive('codeBlock'), () => editor.chain().focus().toggleCodeBlock().run())}
    {item(t('descriptionEditor.table'), editor.isActive('table'), () => editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run())}
    {item(t('descriptionEditor.link'), editor.isActive('link'), onLink)}
  </div>;
}

function ToolbarButton({ className, label, icon: Icon, pressed, onClick }: { className: string; label: string; icon: typeof Bold; pressed: boolean; onClick: () => void }) {
  return <button type="button" className={cn(className, pressed && 'is-active')} aria-label={label} aria-pressed={pressed} title={label}
    onMouseDown={(event) => event.preventDefault()}
    onClick={onClick}>
    <Icon className="size-4" aria-hidden />
  </button>;
}

function LinkPopover({ editor, open, setOpen, href, setHref }: { editor: Editor; open: boolean; setOpen: (value: boolean) => void; href: string; setHref: (value: string) => void }) {
  const { t } = useTranslation('tasks');
  if (!open) return null;
  const sanitized = /^https?:|mailto:/i.test(href) ? href : '';
  return createPortal(<div className="task-link-popover" data-format-tools role="dialog" aria-label={t('descriptionEditor.link')}>
    <input className="task-link-input" aria-label={t('descriptionEditor.linkAddress')} placeholder={t('descriptionEditor.linkPlaceholder')} value={href} onChange={(event) => setHref(event.target.value)} onKeyDown={(event) => {
      if (event.key === 'Enter') { event.preventDefault(); apply(); }
      if (event.key === 'Escape') setOpen(false);
    }} />
    <div className="task-link-actions">
      {sanitized && <a className="task-link-action" href={sanitized} target="_blank" rel="noreferrer">{t('descriptionEditor.open')}</a>}
      <button type="button" className="task-link-action" disabled={!sanitized} onClick={() => { editor.chain().focus().extendMarkRange('link').setLink({ href: sanitized }).run(); setOpen(false); }}>{t('descriptionEditor.apply')}</button>
      <button type="button" className="task-link-action" onClick={() => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); setOpen(false); }}>{t('descriptionEditor.removeLink')}</button>
      <button type="button" className="task-link-action" onClick={() => setOpen(false)}>{t('shared.cancel')}</button>
    </div>
  </div>, document.body);
  function apply() {
    if (!sanitized) return;
    editor.chain().focus().extendMarkRange('link').setLink({ href: sanitized }).run();
    setOpen(false);
  }
}

function useTouchInput() {
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(pointer: coarse)');
    setTouch(query.matches);
    const listener = (event: MediaQueryListEvent) => setTouch(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);
  return touch;
}
