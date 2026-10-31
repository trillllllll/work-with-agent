import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bold, Italic, Link2, List, ListOrdered, ListTodo, Plus, Quote, Redo2, SquareCode, Strikethrough, Table2, Type, Undo2 } from 'lucide-react';
import { externalDocumentChange } from './editor-sync.js';
import { Extension, Node, mergeAttributes, type Editor } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Plugin, Selection } from '@tiptap/pm/state';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from '@tiptap/pm/transform';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { NativeSelect } from '@/components/ui/native-select.js';
import { FormatButton, FormatMenu, LinkEditor, focusEditorNow, type FormatMenuItem } from '@/components/shared/format-controls.js';
import { useTouchInput } from '@/hooks/useTouchInput.js';
import { cn } from '@/lib/utils.js';
import { authHeaders } from '@/lib/api.js';
import { t as translate } from '../../i18n/index.js';
import { safeDocumentLink } from '../../../../server/src/domain/document-content.js';
import { richDocumentToEditor, type LocalRichDocument } from './richdoc-codec.js';
import { richDocumentFromEditorDoc, richDocumentSupported, sameDocument } from '@/lib/documents/content-cache.js';
import { createEditorCore, guardMarkdownRules, insertionFiles } from './editor-core.js';
import { insertPlainText, markdownPasteSlice } from '@/lib/markdown-paste.js';
import { readResourceBytes } from './readers/bytes.js';
import { RichDocumentBoundary } from './RichDocumentBoundary.js';
import './rich-document-editor.css';

const blockTypes = ['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'blockquote', 'codeBlock', 'table', 'tableRow', 'tableCell', 'tableHeader', 'horizontalRule', 'image', 'file', 'upload'];
const selections = new Map<string, { from: number; to: number }>();
/** Existing blocks retain their identity; split/pasted blocks always get new identities. */
export const StableBlockIds = Extension.create({
  name: 'stableBlockIds',
  addGlobalAttributes() { return [{ types: blockTypes, attributes: { blockId: { default: null, parseHTML: () => null, renderHTML: (attrs) => ({ 'data-block-id': attrs.blockId, id: `document-block-${attrs.blockId}` }) } } }]; },
  addProseMirrorPlugins() {
    const fresh = (fragment: Fragment): Fragment => Fragment.fromArray(Array.from({ length: fragment.childCount }, (_, index) => {
      const node = fragment.child(index);
      return node.isText ? node : node.type.create({ ...node.attrs, ...(blockTypes.includes(node.type.name) ? { blockId: crypto.randomUUID() } : {}) }, fresh(node.content), node.marks);
    }));
    return [new Plugin({
      props: { transformPasted: (slice) => new Slice(fresh(slice.content), slice.openStart, slice.openEnd) },
      appendTransaction: (transactions, _old, state) => {
        if (!transactions.some((transaction) => transaction.docChanged)) return null;
        // Typing inside one text block and changing marks cannot introduce block identities.
        // Structural edits (split, join, paste, tables) still receive a complete uniqueness pass.
        if (transactions.every((transaction) => transaction.steps.every((step, index) => {
          if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) return true;
          if (!(step instanceof ReplaceStep) || step.slice.openStart || step.slice.openEnd) return false;
          let textOnly = true; step.slice.content.forEach((node) => { if (!node.isText) textOnly = false; });
          return textOnly && transaction.docs[index].resolve(step.from).sameParent(transaction.docs[index].resolve(step.to));
        }))) return null;
        const seen = new Set<string>(); const tr = state.tr;
        state.doc.descendants((node, pos) => {
          if (!blockTypes.includes(node.type.name)) return;
          const id = node.attrs.blockId as string | null;
          if (!id || seen.has(id)) { const replacement = crypto.randomUUID(); tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: replacement }); seen.add(replacement); }
          else seen.add(id);
        });
        return tr.docChanged ? tr : null;
      },
    })];
  },
});

const Alignment = Extension.create({
  name: 'documentAlignment',
  addGlobalAttributes() { return [{ types: ['paragraph', 'heading', 'tableCell', 'tableHeader'], attributes: { align: { default: null, renderHTML: (attrs) => attrs.align ? { style: `text-align:${['left', 'right', 'center'].includes(attrs.align) ? attrs.align : 'left'}` } : {} } } }]; },
});

function resourceNode(kind: 'image' | 'file' | 'upload') {
  return Node.create({
    name: kind, group: 'block', atom: true, selectable: true, draggable: true,
    addAttributes() { return kind === 'upload' ? { uploadId: { default: '' }, label: { default: '' } }
      : kind === 'file' ? { resourceId: { default: '' }, revision: { default: 0 }, label: { default: '' } }
      : { resourceId: { default: '' }, revision: { default: 0 }, alt: { default: '' }, caption: { default: '' }, width: { default: null } }; },
    parseHTML() { return kind === 'upload' ? [] : [{ tag: `div[data-document-resource="${kind}"]`, getAttrs: (element) => {
      const resourceId = element.getAttribute('data-resource-id') ?? ''; const revision = Number(element.getAttribute('data-revision'));
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(resourceId) || !Number.isSafeInteger(revision) || revision < 1) return false;
      // An HTML identity is never a permission grant: painting and saving both authorize the target version.
      return kind === 'file' ? { resourceId, revision, label: element.textContent ?? '' }
        : { resourceId, revision, alt: element.getAttribute('data-alt') ?? '', caption: element.getAttribute('data-caption') ?? '', width: element.hasAttribute('data-width') ? Math.max(64, Math.min(1600, Number(element.getAttribute('data-width')) || 640)) : null };
    } }]; },
    renderHTML({ node, HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-document-resource': kind, 'data-resource-id': node.attrs.resourceId, 'data-revision': node.attrs.revision, 'data-alt': node.attrs.alt, 'data-caption': node.attrs.caption, ...(node.attrs.width ? { 'data-width': node.attrs.width } : {}) }), String(node.attrs.label || node.attrs.caption || '')]; },
    addNodeView() {
      return ({ node }) => {
        const host = document.createElement(kind === 'image' ? 'figure' : 'div');
        host.className = `document-resource document-resource-${kind}`;
        let current = node; let controller: AbortController | null = null; let objectUrl: string | null = null; let observer: IntersectionObserver | null = null;
        let image: HTMLImageElement | null = null; let caption: HTMLElement | null = null; let link: HTMLAnchorElement | null = null;
        const target = (value: PMNode) => kind === 'upload' ? String(value.attrs.uploadId ?? '') : `${String(value.attrs.resourceId ?? '')}@${Number(value.attrs.revision)}`;
        // Display attributes update the already authorized elements in place; only a new target re-reads bytes.
        const decorate = () => {
          host.id = `document-block-${current.attrs.blockId}`; host.dataset.blockId = String(current.attrs.blockId ?? '');
          if (kind === 'upload') { host.textContent = `${translate('library:docsEditor.uploading')}: ${current.attrs.label}`; return; }
          if (image) { image.alt = String(current.attrs.alt ?? ''); image.style.width = current.attrs.width ? `${Math.min(1600, Math.max(64, Number(current.attrs.width)))}px` : 'auto'; }
          if (caption) caption.textContent = String(current.attrs.caption ?? '');
          if (link) { link.download = String(current.attrs.label || 'attachment'); link.textContent = String(current.attrs.label || translate('library:docsEditor.file')); }
        };
        const paint = () => {
          observer?.disconnect(); observer = null; controller?.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null;
          image = null; caption = null; link = null;
          host.replaceChildren(); decorate();
          if (kind === 'upload') return;
          const resourceId = String(current.attrs.resourceId); const revision = Number(current.attrs.revision);
          host.textContent = translate('library:docsEditor.file');
          if (!/^[a-zA-Z0-9_-]+$/.test(resourceId) || !Number.isSafeInteger(revision) || revision < 1) return;
          const load = () => {
          controller = new AbortController(); const signal = controller.signal;
          const path = `/api/v1/library/resources/${encodeURIComponent(resourceId)}/versions/${revision}/original`;
          void fetch(`/api/v1/library/resources/${encodeURIComponent(resourceId)}?revision=${revision}`, { headers: authHeaders(), credentials: 'include', signal }).then(async (response) => {
            if (!response.ok) throw new Error('RESOURCE_UNAVAILABLE');
            const result = await response.json() as { data?: { attachment?: { mimeType?: string } } };
            const mime = result.data?.attachment?.mimeType || '';
            if (signal.aborted) return;
            if (kind === 'file') {
              host.replaceChildren(); link = document.createElement('a'); link.href = path; host.append(link); decorate(); return;
            }
            if (kind === 'image' && !/^image\/(png|jpeg|gif|webp|avif|bmp)(;|$)/i.test(mime)) throw new Error('UNSUPPORTED_IMAGE');
            const bytes = await readResourceBytes(path, signal); if (signal.aborted) return;
            objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime })); host.replaceChildren();
            if (kind === 'image') {
              image = document.createElement('img'); image.src = objectUrl; image.loading = 'lazy';
              caption = document.createElement('figcaption'); host.append(image, caption); decorate();
            }
          }).catch(() => { if (!signal.aborted) host.textContent = translate('library:docsEditor.unavailable'); });
          };
          if (typeof IntersectionObserver === 'undefined') load();
          else { observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { observer?.disconnect(); observer = null; load(); } }, { rootMargin: '400px' }); observer.observe(host); }
        };
        paint();
        return {
          dom: host, ignoreMutation: () => true,
          update(next: PMNode) {
            if (next.type.name !== kind) return false;
            const retarget = target(next) !== target(current);
            current = next;
            if (retarget) paint(); else decorate();
            return true;
          },
          destroy() { observer?.disconnect(); controller?.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); },
        };
      };
    },
  });
}

/** Everything the format controls display. Read per transaction; cheap selection-local queries only. */
export type ToolbarState = {
  bold: boolean; italic: boolean; strike: boolean; code: boolean; link: boolean; linkHref: string; heading: number;
  bulletList: boolean; orderedList: boolean; taskList: boolean; blockquote: boolean; codeBlock: boolean; table: boolean; language: string;
  /** Deleting the last row or column is refused by the table commands; delete the table instead. */
  canDeleteRow: boolean; canDeleteColumn: boolean;
  image: boolean; alt: string; caption: string; width: number; resource: boolean;
};
const idleToolbar: ToolbarState = { bold: false, italic: false, strike: false, code: false, link: false, linkHref: '', heading: 0, bulletList: false, orderedList: false, taskList: false, blockquote: false, codeBlock: false, table: false, language: '', canDeleteRow: false, canDeleteColumn: false, image: false, alt: '', caption: '', width: 640, resource: false };
function toolbarState(editor: Editor | null): ToolbarState {
  if (!editor || editor.isDestroyed) return idleToolbar;
  const image = editor.isActive('image'); const codeBlock = editor.isActive('codeBlock'); const link = editor.isActive('link');
  const table = editor.isActive('table');
  const imageAttrs = image ? editor.getAttributes('image') : null;
  return {
    bold: editor.isActive('bold'), italic: editor.isActive('italic'), strike: editor.isActive('strike'), code: editor.isActive('code'),
    link, linkHref: link ? String(editor.getAttributes('link').href ?? '') : '',
    heading: editor.isActive('heading') ? Number(editor.getAttributes('heading').level) || 1 : 0,
    bulletList: editor.isActive('bulletList'), orderedList: editor.isActive('orderedList'), taskList: editor.isActive('taskList'),
    blockquote: editor.isActive('blockquote'), codeBlock, table,
    language: codeBlock ? String(editor.getAttributes('codeBlock').language ?? '') : '',
    canDeleteRow: table && editor.can().deleteRow(), canDeleteColumn: table && editor.can().deleteColumn(),
    image, alt: String(imageAttrs?.alt ?? ''), caption: String(imageAttrs?.caption ?? ''), width: Number(imageAttrs?.width ?? 640) || 640,
    resource: image || editor.isActive('file') || editor.isActive('upload'),
  };
}

/** The rich document editor's schema-defining extensions; tests build the same schema from this list. */
export function documentEditorExtensions() {
  return guardMarkdownRules([
    ...createEditorCore({ isAllowedUri: (url) => safeDocumentLink(url) }), Table.configure({ resizable: false }), TableRow, TableCell, TableHeader,
    StableBlockIds, Alignment, resourceNode('image'), resourceNode('file'), resourceNode('upload'),
  ]);
}

type RichDocumentEditorProps = {
  value: LocalRichDocument; onChange: (value: LocalRichDocument) => void; readOnly?: boolean;
  /** Show paginated reading instead of the editor (the document was opened above the editing budget). */
  paginate?: boolean;
  /** Offered while paginated when the document is within the hard budget. */
  onEditAnyway?: () => void;
  /** Paginated because the document is above the hard budget (decides the notice when "edit anyway" is not offered). */
  overHardLimit?: boolean;
  onCompositionChange?: (composing: boolean) => void;
  onInsertFiles?: (files: File[], bookmark?: { blockId: string }) => void;
  onInsertExisting?: (bookmark?: { blockId: string }) => void;
  onUndo?: () => boolean | void; onRedo?: () => boolean | void;
  onPendingChange?: (pending: boolean) => void;
  onSerializationFailure?: (editorJson: unknown, message: string) => void;
  registerFlush?: (flush: () => boolean) => () => void;
  sessionKey: string;
  /** Where the workspace shows the format controls, in its own single toolbar row. Without it they render above the body. */
  formatSlot?: HTMLElement | null;
};

/**
 * How many format controls fit beside the workspace's other toolbar controls. Measured on the slot, whose width
 * comes from the free space in the row, not from its content. Touch targets are 44px instead of 32px.
 */
export type FormatTier = 'full' | 'wide' | 'compact' | 'minimal';
export function formatTierFor(width: number, touch: boolean): FormatTier {
  const [full, wide, compact] = touch ? [660, 430, 240] : [520, 340, 180];
  return width >= full ? 'full' : width >= wide ? 'wide' : width >= compact ? 'compact' : 'minimal';
}
function useFormatTier(slot: HTMLElement | null | undefined, touch: boolean): FormatTier {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!slot) { setWidth(null); return; }
    const measure = () => setWidth(slot.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure); observer.observe(slot);
    return () => observer.disconnect();
  }, [slot]);
  return width === null ? 'full' : formatTierFor(width, touch);
}
/** Controls shown in the row for each tier, in row order; the rest move into "More formatting". */
const inlineFormats: Record<FormatTier, ReadonlySet<string>> = {
  full: new Set(['bold', 'italic', 'strike', 'heading', 'bulletList', 'orderedList', 'taskList', 'quote', 'codeBlock', 'link', 'undo', 'redo']),
  wide: new Set(['bold', 'italic', 'heading', 'bulletList', 'orderedList', 'link']),
  compact: new Set(['bold', 'bulletList', 'link']),
  minimal: new Set(),
};

export function RichDocumentEditor(props: RichDocumentEditorProps) {
  const supported = useMemo(() => richDocumentSupported(props.value), [props.value]);
  if (!supported) return <RichDocumentEditorCore {...props} />;
  return <RichDocumentBoundary value={props.value} paginate={props.paginate === true} overHardLimit={props.overHardLimit === true} onEditAnyway={props.onEditAnyway} renderEditor={(value, paginated) => <RichDocumentEditorCore {...props} key={paginated ? value.blocks[0]?.id ?? 'empty' : 'editing'} value={value} readOnly={props.readOnly || paginated} {...(paginated ? { registerFlush: undefined, onPendingChange: undefined, onCompositionChange: undefined } : {})} />} />;
}

function RichDocumentEditorCore({ value, onChange, readOnly = false, onCompositionChange, onInsertFiles, onInsertExisting, onUndo, onRedo, onPendingChange, onSerializationFailure, registerFlush, sessionKey, formatSlot }: RichDocumentEditorProps) {
  const { t } = useTranslation('library');
  const { t: tf } = useTranslation('editor');
  const touch = useTouchInput();
  const tier = useFormatTier(formatSlot, touch);
  const [linkOpen, setLinkOpen] = useState(false);
  const current = useRef({ value, onChange, readOnly, onCompositionChange, onInsertFiles, onUndo, onRedo, onPendingChange, onSerializationFailure }); current.current = { value, onChange, readOnly, onCompositionChange, onInsertFiles, onUndo, onRedo, onPendingChange, onSerializationFailure };
  const composing = useRef(false); const lastContent = useRef<LocalRichDocument | null>(value);
  const serializeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);
  const historyJump = useRef(0);
  const plainPaste = useRef(false);
  const deferredEditable = useRef<boolean | null>(null);
  const fileInput = useRef<HTMLInputElement>(null); const [error, setError] = useState('');
  const supported = useMemo(() => richDocumentSupported(value), [value]);
  // The editor reads its initial content only when it is created for this view; later bodies arrive as transactions.
  const editorContent = useMemo(() => supported ? richDocumentToEditor(value) : { type: 'doc', content: [{ type: 'paragraph' }] }, [sessionKey]);
  const editor = useEditor({
    extensions: documentEditorExtensions(),
    content: editorContent,
    editable: supported && !readOnly,
    editorProps: {
      attributes: { class: 'document-prose', role: 'textbox', 'aria-multiline': 'true', 'aria-label': t('docsEditor.label') },
      handleKeyDown: (_view, event) => {
        // Mod+Shift+V pastes plain text, so Markdown characters stay as typed. Browsers that bind the shortcut paste
        // synchronously as its default action; where nothing pastes (Safari, the desktop WebView) the flag must not
        // linger into a later ordinary paste.
        if (event.key.toLowerCase() === 'v' && event.shiftKey && (event.metaKey || event.ctrlKey)) { plainPaste.current = true; window.setTimeout(() => { plainPaste.current = false; }, 0); }
        if (composing.current || current.current.readOnly || !(event.metaKey || event.ctrlKey)) return false;
        const action = event.key.toLowerCase() === 'z' ? event.shiftKey ? current.current.onRedo : current.current.onUndo : event.key.toLowerCase() === 'y' ? current.current.onRedo : undefined;
        if (!action) return false; event.preventDefault(); travel(action); return true;
      },
      handlePaste: (view, event) => {
        const plain = plainPaste.current; plainPaste.current = false;
        if (current.current.readOnly) return false;
        const files = insertionFiles(event.clipboardData, 'all');
        if (files.length) { event.preventDefault(); event.stopPropagation(); insert(files); return true; }
        const text = event.clipboardData?.getData('text/plain') ?? '';
        const { $from } = view.state.selection;
        // Code keeps pasted characters exactly; ProseMirror's own paste already does that there.
        if (!text || $from.parent.type.spec.code || $from.marks().some((mark) => mark.type.name === 'code')) return false;
        if (plain) { event.preventDefault(); insertPlainText(view, text); return true; }
        // HTML goes through the schema's parse rules; Markdown text (e.g. a copied assistant reply) becomes formatting.
        if (event.clipboardData?.getData('text/html')) return false;
        const slice = markdownPasteSlice(text, view.state.schema, { isAllowedLink: safeDocumentLink });
        if (!slice) return false;
        event.preventDefault();
        view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
        return true;
      },
      handleDrop: (_view, event, _slice, moved) => {
        if (current.current.readOnly || moved) return false;
        const files = insertionFiles(event.dataTransfer, 'all'); if (!files.length) return false;
        event.preventDefault(); event.stopPropagation(); insert(files); return true;
      },
      handleDOMEvents: {
        copy: (view, event) => {
          let pending = false; view.state.selection.content().content.descendants((node) => { if (node.type.name === 'upload') pending = true; });
          if (!pending) return false; event.preventDefault(); setError(t('docsEditor.uploadCopyPending')); return true;
        },
        cut: (view, event) => {
          let pending = false; view.state.selection.content().content.descendants((node) => { if (node.type.name === 'upload') pending = true; });
          if (!pending) return false; event.preventDefault(); setError(t('docsEditor.uploadCopyPending')); return true;
        },
        blur: () => { emit(); return false; },
        compositionstart: () => { composing.current = true; current.current.onCompositionChange?.(true); return false; },
        compositionend: () => {
          composing.current = false;
          queueMicrotask(() => {
            flushEditor(); current.current.onCompositionChange?.(false);
            // An editability change that arrived during composition is applied once the candidate text is committed.
            if (deferredEditable.current !== null && editor && !editor.isDestroyed) { editor.setEditable(deferredEditable.current); deferredEditable.current = null; }
          });
          return false;
        },
      },
    },
    // Batch full serialization; ProseMirror handles keystrokes without scanning the whole product document.
    onUpdate: ({ transaction }) => {
      // setEditable also emits an update event without changing the document. It must
      // not create an unflushable pending buffer after a read-only/recovery transition.
      if (!transaction.docChanged || current.current.readOnly) return;
      if (!pending.current) { pending.current = true; current.current.onPendingChange?.(true); }
      if (!serializeTimer.current) serializeTimer.current = setTimeout(emit, 250);
    },
    onCreate: ({ editor }) => { const selection = selections.get(sessionKey); if (selection) { const size = editor.state.doc.content.size; editor.commands.setTextSelection({ from: Math.min(size, selection.from), to: Math.min(size, selection.to) }); } },
    onSelectionUpdate: ({ editor }) => { selections.set(sessionKey, { from: editor.state.selection.from, to: editor.state.selection.to }); },
  }, [sessionKey]);
  // Attribute edits keep the same selection, so toolbar controls follow every transaction instead of selection changes.
  const tools = useEditorState({ editor, selector: ({ editor: live }) => toolbarState(live) }) ?? idleToolbar;
  function emit() {
    if (serializeTimer.current) { clearTimeout(serializeTimer.current); serializeTimer.current = null; }
    if (!editor || editor.isDestroyed || current.current.readOnly) return false;
    try {
      // Only top-level blocks whose editor node changed are converted and validated again.
      const content = richDocumentFromEditorDoc(editor.state.doc);
      const changed = !sameDocument(content, lastContent.current);
      if (changed) { lastContent.current = content; current.current.onChange(content); }
      pending.current = false; current.current.onPendingChange?.(false);
      setError('');
      return changed;
    } catch {
      const editorJson = editor.getJSON();
      const message = t('docsEditor.unknown'); setError(message);
      if (current.current.onSerializationFailure) {
        try { current.current.onSerializationFailure(editorJson, message); pending.current = false; current.current.onPendingChange?.(false); }
        catch { /* Keep the original live editor pending if even its raw state cannot be captured. */ }
      }
      return false;
    }
  }
  function insert(files: File[]) {
    emit();
    current.current.onInsertFiles?.(files, bookmark());
  }
  /** Session undo/redo arrives as an external body; remember it so the caret follows the change. */
  function travel(action: (() => boolean | void) | undefined) {
    emit(); historyJump.current = Date.now();
    if (action?.() === false) historyJump.current = 0;
  }
  function bookmark() {
    const selection = editor?.state.selection.$from;
    const blockId = selection?.depth ? String(selection.node(1).attrs.blockId ?? '') : '';
    return blockId ? { blockId } : undefined;
  }
  function flushEditor() {
    if (editor && !editor.isDestroyed) {
      // Drain DOM edits that precede the observer callback, including the final IME input.
      (editor.view as typeof editor.view & { domObserver?: { flush: () => void } }).domObserver?.flush();
    }
    if (pending.current) emit();
    return !pending.current;
  }
  useEffect(() => {
    const editable = supported && !readOnly;
    // Changing editability during IME composition would cancel the candidate text.
    if (composing.current) { deferredEditable.current = editable; return; }
    deferredEditable.current = null;
    editor?.setEditable(editable);
  }, [editor, supported, readOnly]);
  useLayoutEffect(() => {
    const flush = () => flushEditor();
    const unregister = registerFlush?.(flush);
    return () => { flush(); unregister?.(); if (composing.current) { composing.current = false; current.current.onCompositionChange?.(false); } };
  }, [editor, registerFlush]);
  useEffect(() => {
    // Only an external body that answers this view's own undo/redo moves the caret; remote bodies keep mapped selections.
    const jumped = historyJump.current > 0 && Date.now() - historyJump.current < 2_000; historyJump.current = 0;
    if (!editor || editor.isDestroyed || composing.current || !supported) return;
    // The session keeps the body this view emitted, so the usual case is the same object.
    if (value === lastContent.current) return;
    if (lastContent.current && sameDocument(value, lastContent.current)) { lastContent.current = value; return; }
    if (serializeTimer.current && emit()) return;
    const incoming = editor.schema.nodeFromJSON(richDocumentToEditor(value));
    const change = externalDocumentChange(editor.state, incoming);
    lastContent.current = value;
    if (!change) return;
    if (jumped) change.transaction.setSelection(Selection.near(change.transaction.doc.resolve(change.to), -1)).scrollIntoView();
    editor.view.dispatch(change.transaction);
  }, [editor, value, supported]);
  if (!supported) return <div className="document-unknown" role="status"><p>{t('docsEditor.unknown')}</p><pre>{JSON.stringify(value, null, 2)}</pre></div>;
  // Focus synchronously first: a control that took focus (a menu item, the heading select) would otherwise make
  // Tiptap re-focus the editor a frame later, taking focus back from whatever the user moved to in between.
  const chain = () => { focusEditorNow(editor); return editor?.chain().focus(); };
  const busy = !editor || composing.current;
  const buttonClass = cn('document-format-button', touch && 'touch');
  const inline = inlineFormats[tier];
  const formats = [
    { key: 'bold', label: tf('bold'), icon: Bold, active: tools.bold, run: () => chain()?.toggleBold().run() },
    { key: 'italic', label: tf('italic'), icon: Italic, active: tools.italic, run: () => chain()?.toggleItalic().run() },
    { key: 'strike', label: tf('strike'), icon: Strikethrough, active: tools.strike, run: () => chain()?.toggleStrike().run() },
    { key: 'bulletList', label: tf('bulletList'), icon: List, active: tools.bulletList, run: () => chain()?.toggleBulletList().run() },
    { key: 'orderedList', label: tf('orderedList'), icon: ListOrdered, active: tools.orderedList, run: () => chain()?.toggleOrderedList().run() },
    { key: 'taskList', label: tf('checklist'), icon: ListTodo, active: tools.taskList, run: () => chain()?.toggleTaskList().run() },
    { key: 'quote', label: tf('quote'), icon: Quote, active: tools.blockquote, run: () => chain()?.toggleBlockquote().run() },
    { key: 'codeBlock', label: tf('codeBlock'), icon: SquareCode, active: tools.codeBlock, run: () => chain()?.toggleCodeBlock().run() },
    { key: 'link', label: tf('link'), icon: Link2, active: tools.link, run: () => setLinkOpen(true) },
    { key: 'undo', label: t('docsEditor.undo'), icon: Undo2, run: () => { focusEditorNow(editor); if (onUndo) travel(onUndo); else chain()?.undo().run(); } },
    { key: 'redo', label: t('docsEditor.redo'), icon: Redo2, run: () => { focusEditorNow(editor); if (onRedo) travel(onRedo); else chain()?.redo().run(); } },
  ] satisfies Array<{ key: string; label: string; icon: typeof Bold; active?: boolean; run: () => void }>;
  const button = (key: string) => { const format = formats.find((entry) => entry.key === key)!; return <FormatButton key={key} className={buttonClass} label={format.label} icon={format.icon} pressed={format.active} disabled={busy} onClick={format.run} />; };
  const setHeading = (level: number) => { if (level) chain()?.setHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 }).run(); else chain()?.setParagraph().run(); };
  // The same levels and labels as the heading select of the wide tiers.
  const headingItems: FormatMenuItem[] = [0, 1, 2, 3, 4, 5, 6].map((level) => ({ key: `heading-${level}`, label: level ? `${t('docsEditor.heading')} ${level}` : t('docsEditor.paragraph'), active: tools.heading === level, onSelect: () => setHeading(level) }));
  const overflow: FormatMenuItem[] = [
    ...(inline.has('heading') ? [] : headingItems),
    ...formats.filter((format) => !inline.has(format.key)).map((format) => ({ key: format.key, label: format.label, active: format.active, onSelect: format.run })),
  ];
  const insertItems: FormatMenuItem[] = [
    { key: 'file', label: t('docsEditor.insert'), onSelect: () => fileInput.current?.click() },
    ...(onInsertExisting ? [{ key: 'reuse', label: t('docsEditor.reuse'), onSelect: () => { emit(); onInsertExisting(bookmark()); } }] : []),
    { key: 'table', label: t('docsEditor.table'), onSelect: () => chain()?.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { key: 'rule', label: t('docsEditor.rule'), onSelect: () => chain()?.setHorizontalRule().run() },
  ];
  const formatArea = !readOnly && <div className={cn('document-editor-toolbar', formatSlot && 'in-slot')} role="toolbar" aria-label={t('docsEditor.toolbar')} data-tier={tier}>
    {['bold', 'italic', 'strike'].filter((key) => inline.has(key)).map(button)}
    {inline.has('heading') && <NativeSelect aria-label={t('docsEditor.heading')} value={String(tools.heading)} disabled={busy} onChange={(event) => setHeading(Number(event.target.value))}><option value="0">{t('docsEditor.paragraph')}</option>{[1, 2, 3, 4, 5, 6].map((level) => <option value={level} key={level}>{t('docsEditor.heading')} {level}</option>)}</NativeSelect>}
    {['bulletList', 'orderedList', 'taskList', 'quote', 'codeBlock', 'link'].filter((key) => inline.has(key)).map(button)}
    <FormatMenu label={t('docsEditor.insertMenu')} icon={Plus} items={insertItems} triggerClassName={buttonClass} contentClassName="document-format-menu" />
    {['undo', 'redo'].filter((key) => inline.has(key)).map(button)}
    {overflow.length > 0 && <FormatMenu label={tf('moreFormats')} icon={Type} items={overflow} triggerClassName={buttonClass} contentClassName="document-format-menu" align="end" />}
    <Input variant="inline" ref={fileInput} className="sr-only" type="file" multiple tabIndex={-1} aria-hidden aria-label={t('docsEditor.insert')} onChange={(event) => { insert([...(event.target.files ?? [])]); event.target.value = ''; }} />
  </div>;
  // Attributes of the selected code block or resource, and the rows and columns of the table at the cursor; shown only then.
  const tableItems: FormatMenuItem[] = [
    { key: 'rowBefore', label: t('docsEditor.rowBefore'), onSelect: () => chain()?.addRowBefore().run() },
    { key: 'rowAfter', label: t('docsEditor.rowAfter'), onSelect: () => chain()?.addRowAfter().run() },
    { key: 'columnBefore', label: t('docsEditor.columnBefore'), onSelect: () => chain()?.addColumnBefore().run() },
    { key: 'columnAfter', label: t('docsEditor.columnAfter'), onSelect: () => chain()?.addColumnAfter().run() },
    { key: 'deleteRow', label: t('docsEditor.deleteRow'), disabled: !tools.canDeleteRow, onSelect: () => chain()?.deleteRow().run() },
    { key: 'deleteColumn', label: t('docsEditor.deleteColumn'), disabled: !tools.canDeleteColumn, onSelect: () => chain()?.deleteColumn().run() },
    { key: 'deleteTable', label: t('docsEditor.deleteTable'), onSelect: () => chain()?.deleteTable().run() },
  ];
  const context = !readOnly && (tools.codeBlock || tools.image || tools.resource || tools.table) && <div className="document-context-tools" role="group" aria-label={t('docsEditor.contextTools')}>
    {tools.table && <FormatMenu label={t('docsEditor.tableMenu')} icon={Table2} items={tableItems} showLabel contentClassName="document-format-menu" />}
    {tools.codeBlock && <Input aria-label={t('docsEditor.language')} placeholder={t('docsEditor.language')} value={tools.language} onChange={(event) => editor?.commands.updateAttributes('codeBlock', { language: event.target.value })} />}
    {tools.image && <>
      <Input aria-label={t('docsEditor.alt')} placeholder={t('docsEditor.alt')} value={tools.alt} onChange={(event) => editor?.commands.updateAttributes('image', { alt: event.target.value })} />
      <Input aria-label={t('docsEditor.caption')} placeholder={t('docsEditor.caption')} value={tools.caption} onChange={(event) => editor?.commands.updateAttributes('image', { caption: event.target.value })} />
      <Input aria-label={t('docsEditor.width')} type="range" min="64" max="1600" value={tools.width} onChange={(event) => editor?.commands.updateAttributes('image', { width: Number(event.target.value) })} />
    </>}
    {tools.resource && <Button type="button" size="sm" variant="ghost" disabled={busy} onMouseDown={(event) => event.preventDefault()} onClick={() => { chain()?.deleteSelection().run(); }}>{t('docsEditor.remove')}</Button>}
  </div>;
  return <div className="document-editor">
    {formatArea && (formatSlot ? createPortal(formatArea, formatSlot) : formatArea)}
    {context}
    {error && <p role="alert">{error}</p>}
    <EditorContent editor={editor} />
    {editor && !readOnly && <LinkEditor editor={editor} open={linkOpen} onOpenChange={setLinkOpen} isAllowedUri={safeDocumentLink} />}
  </div>;
}
