import { Extension, Node, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import type { Node as PMNode, NodeType } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Image } from '@tiptap/extension-image';
import { Table } from '@tiptap/extension-table';
import { isTaskImageSrc } from '@/lib/task-description.js';

/** 原文片段：不支持的 Markdown 块逐字保留为原子块，点击打开纯文本编辑弹层。 */
export function RawMarkdownNode(handlers: { editRaw: (pos: number, markdown: string) => void }) {
  return Node.create({
    name: 'rawMarkdown',
    group: 'block',
    atom: true,
    selectable: true,
    addAttributes() {
      return { markdown: { default: '' } };
    },
    parseHTML() {
      return [{ tag: 'div[data-raw-markdown]' }];
    },
    renderHTML({ HTMLAttributes }) {
      return ['div', mergeAttributes(HTMLAttributes, { 'data-raw-markdown': 'true' })];
    },
    addNodeView() {
      return (props) => {
        const host = document.createElement('div');
        host.className = 'task-raw-block';
        host.setAttribute('role', 'button');
        host.setAttribute('tabindex', '-1');
        host.setAttribute('aria-label', '原文片段，回车修改');
        const text = document.createElement('pre');
        text.className = 'task-raw-text';
        text.textContent = String(props.node.attrs.markdown ?? '');
        const hint = document.createElement('span');
        hint.className = 'task-raw-hint';
        hint.textContent = '原文片段';
        host.append(hint, text);
        let lastClick = 0;
        host.addEventListener('mousedown', (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const now = Date.now();
          const pos = typeof props.getPos === 'function' ? props.getPos() : undefined;
          if (typeof pos !== 'number' || !Number.isFinite(pos)) return;
          // 单击预览，再次点击进入纯文本编辑。
          if (now - lastClick < 480) handlers.editRaw(pos, String(props.node.attrs.markdown ?? ''));
          lastClick = now;
        });
        const view: NodeView = { dom: host, ignoreMutation: () => true };
        return view;
      };
    },
  });
}

/** 资料引用：原子行内节点，点击打开资料预览。 */
export function MaterialReferenceNode(handlers: { openMaterial: (materialId: string) => void }) {
  return Node.create({
    name: 'materialReference',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    addAttributes() {
      return { materialId: { default: '' }, label: { default: '' } };
    },
    parseHTML() {
      return [{ tag: 'a[data-wwa-material]' }];
    },
    renderHTML({ HTMLAttributes }) {
      return ['a', mergeAttributes(HTMLAttributes, { 'data-wwa-material': 'true' })];
    },
    addNodeView() {
      return (props) => {
        const anchor = document.createElement('a');
        anchor.className = 'task-material-ref';
        anchor.setAttribute('data-wwa-material', 'true');
        anchor.title = '资料引用';
        let current = props.node;
        const paint = () => {
          anchor.textContent = String(current.attrs.label ?? '');
          anchor.dataset.testid = `material-reference-${String(current.attrs.materialId ?? '')}`;
        };
        paint();
        anchor.addEventListener('mousedown', (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          handlers.openMaterial(String(current.attrs.materialId ?? ''));
        });
        const view: NodeView = {
          dom: anchor,
          ignoreMutation: () => true,
          update: (node) => {
            if (node.type.name !== 'materialReference') return false;
            current = node;
            paint();
            return true;
          },
        };
        return view;
      };
    },
  });
}

/** 任务图片：只加载当前任务地址的图片，右键放大。 */
export function TaskImageNode(taskIdGetter: () => string, handlers: { zoom: (src: string) => void }) {
  return Image.extend({
    name: 'image',
    inline: true,
    group: 'inline',
    addNodeView() {
      return (props) => {
        const figure = document.createElement('span');
        figure.className = 'task-image';
        const image = document.createElement('img');
        let current = props.node;
        const apply = () => {
          const src = typeof current.attrs.src === 'string' ? current.attrs.src : '';
          if (!src || !isTaskImageSrc(taskIdGetter(), src)) {
            image.removeAttribute('src');
            figure.classList.add('task-image-blocked');
            image.alt = '不可加载的图片地址';
            return;
          }
          figure.classList.remove('task-image-blocked');
          image.src = src;
          image.alt = typeof current.attrs.alt === 'string' ? current.attrs.alt : '';
        };
        apply();
        figure.append(image);
        figure.addEventListener('contextmenu', (event) => {
          const src = typeof current.attrs.src === 'string' ? current.attrs.src : '';
          if (!isTaskImageSrc(taskIdGetter(), src)) return;
          event.preventDefault();
          handlers.zoom(src);
        });
        const view: NodeView = {
          dom: figure,
          update(updated: PMNode) {
            if (updated.type.name !== 'image') return false;
            current = updated;
            apply();
            return true;
          },
          ignoreMutation: () => true,
        };
        return view;
      };
    },
  });
}

/** GFM 列对齐保留在 table 节点属性上。 */
export const AlignedTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      alignments: {
        default: [] as Array<'left' | 'center' | 'right' | null>,
        parseHTML: (element) => {
          const value = element.getAttribute('data-alignments');
          if (!value) return [];
          try { return JSON.parse(value) as Array<'left' | 'center' | 'right' | null>; } catch { return []; }
        },
        renderHTML: (attributes) => {
          const value = attributes.alignments;
          return Array.isArray(value) && value.length ? { 'data-alignments': JSON.stringify(value) } : {};
        },
      },
    };
  },
});

/** 光标在代码块里时，图片改插到代码块之后，避免把代码挤出代码块。 */
export function imageInsertAt(doc: PMNode, pos: number): number {
  const size = doc.content.size;
  const at = Math.max(0, Math.min(pos, size));
  const resolved = doc.resolve(at);
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    if (resolved.node(depth).type.spec.code) return resolved.after(depth);
  }
  return at;
}

export function taskImageContent(doc: PMNode, pos: number, src: string, imageType: NodeType | null | undefined): { at: number; content: { type: string; attrs?: { src: string; alt: string }; content?: { type: string; attrs?: { src: string; alt: string } }[] } } {
  const at = imageInsertAt(doc, pos);
  const parent = doc.resolve(Math.max(0, Math.min(at, doc.content.size))).parent;
  const image = { type: 'image', attrs: { src, alt: '' } };
  const inlineOk = Boolean(imageType) && !parent.type.spec.code && parent.type.contentMatch.matchType(imageType!) != null;
  return { at, content: inlineOk ? image : { type: 'paragraph', content: [image] } };
}

/**
 * 触屏上 TaskItem 对 mousedown preventDefault，随后的 click/change 不会发生。
 * 勾选框会被点亮，但节点属性仍是未勾选。指针抬起后再把勾选框状态写回任务项。
 */
export const TaskItemPointerSync = Extension.create({
  name: 'taskItemPointerSync',
  addProseMirrorPlugins() {
    const sync = (view: EditorView, input: HTMLInputElement) => {
      if (!view.editable || view.isDestroyed) return;
      const item = input.closest('ul[data-type="taskList"] > li, ul[data-type="taskList"] li');
      if (!(item instanceof HTMLElement) || !view.dom.contains(item)) return;
      const found: { node: PMNode | null; pos: number } = { node: null, pos: -1 };
      view.state.doc.descendants((node, pos) => {
        if (found.node || node.type.name !== 'taskItem') return true;
        if (view.nodeDOM(pos) === item) {
          found.node = node;
          found.pos = pos;
          return false;
        }
        return true;
      });
      if (!found.node || Boolean(found.node.attrs.checked) === input.checked) return;
      view.dispatch(view.state.tr.setNodeMarkup(found.pos, undefined, { ...found.node.attrs, checked: input.checked }));
    };
    const schedule = (view: EditorView, event: Event) => {
      const target = event.target;
      const input = target instanceof HTMLInputElement && target.type === 'checkbox'
        ? target
        : target instanceof Element
          ? target.closest('label')?.querySelector('input[type="checkbox"]')
          : null;
      if (!(input instanceof HTMLInputElement) || !view.dom.contains(input)) return false;
      // 触屏会先点亮勾选框，再取消 click。等这一轮事件结束再读 checked。
      requestAnimationFrame(() => sync(view, input));
      setTimeout(() => sync(view, input), 0);
      return false;
    };
    return [new Plugin({ props: { handleDOMEvents: { pointerup: schedule, click: schedule } } })];
  },
});

/** 上传装饰：位置随事务映射；完成前可被用户取消。 */
export const uploadKey = new PluginKey<{ decorations: DecorationSet }>('task-image-uploads');

export const UploadDecorations = Extension.create({
  name: 'taskImageUploads',
  addProseMirrorPlugins() {
    return [
      new Plugin<{ decorations: DecorationSet }>({
        key: uploadKey,
        state: {
          init: () => ({ decorations: DecorationSet.empty }),
          apply(tr, value) {
            let decorations = value.decorations.map(tr.mapping, tr.doc);
            const meta = tr.getMeta(uploadKey) as { type: 'add' | 'remove'; uploadId: string; pos?: number; fileName?: string } | undefined;
            if (meta?.type === 'add' && typeof meta.pos === 'number') {
              const widget = document.createElement('span');
              widget.className = 'task-upload-chip';
              widget.setAttribute('role', 'status');
              widget.textContent = `${meta.fileName ?? '图片'} 上传中…`;
              const cancel = document.createElement('button');
              cancel.type = 'button';
              cancel.className = 'task-upload-cancel';
              cancel.setAttribute('aria-label', '取消上传');
              cancel.textContent = '×';
              widget.append(cancel);
              decorations = decorations.add(tr.doc, [Decoration.widget(meta.pos, widget, { id: meta.uploadId })]);
            } else if (meta?.type === 'remove') {
              decorations = DecorationSet.create(tr.doc, decorations.find().filter((deco) => (deco.spec as { id?: string } | undefined)?.id !== meta.uploadId));
            }
            return { decorations };
          },
        },
        props: {
          decorations(state) {
            return uploadKey.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

export function findUploadPosition(decorations: DecorationSet, uploadId: string): number | null {
  const found = decorations.find(undefined, undefined, (spec) => (spec as { id?: string }).id === uploadId);
  return found.length ? found[0].from : null;
}
