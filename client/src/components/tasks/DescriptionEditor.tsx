import { useImperativeHandle, useLayoutEffect, useRef, type FocusEvent, type Ref } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { Compartment, EditorSelection, EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { BlockType, type BlockInfo, Decoration, EditorView, keymap, placeholder, WidgetType, type DecorationSet } from '@codemirror/view';
import { MarkdownView } from '@/components/chat/MarkdownView.js';
import { blockHoldsCaret, markdownBlocks } from '@/lib/markdown-blocks.js';
import { isTaskImageSrc } from '@/lib/task-description.js';
import { cn } from '@/lib/utils.js';

const views = new WeakMap<HTMLElement, EditorView>();
const previewRefresh = StateEffect.define<null>();
const setFocused = StateEffect.define<boolean>();
const editableSlot = new Compartment();

// EditContext keeps its own selection. A block widget then makes a select-all insert
// land at the caret, in front of the existing text. This editor stays on the DOM path.
(EditorView as unknown as { EDIT_CONTEXT: boolean }).EDIT_CONTEXT = false;

type Handlers = {
  edit: (pos: number) => void;
  zoom: (src: string) => void;
  remeasure: () => void;
};

export type DescriptionHandle = {
  insert: (text: string) => void;
  blur: () => void;
  focus: () => void;
};

export function readDescriptionCaret(node: HTMLElement) {
  const view = views.get(node);
  if (!view) return null;
  const range = view.state.selection.main;
  return { start: range.from, end: range.to };
}

export function placeDescriptionCaret(node: HTMLElement, start: number, end: number) {
  const view = views.get(node);
  if (!view || !view.state.facet(EditorView.editable)) return false;
  const length = view.state.doc.length;
  const from = Math.max(0, Math.min(start, length));
  const to = Math.max(from, Math.min(end, length));
  // Reveal the caret block before focusing, so the selection is not inside a widget.
  view.dispatch({ selection: EditorSelection.range(from, to), effects: setFocused.of(true) });
  view.focus();
  return view.root.activeElement === view.contentDOM;
}

function insertText(view: EditorView, text: string) {
  const range = view.state.selection.main;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: EditorSelection.cursor(range.from + text.length),
  });
  view.focus();
}

class PreviewWidget extends WidgetType {
  private root: Root | null = null;

  constructor(readonly source: string, readonly taskId: string, readonly from: number, readonly handlers: Handlers) {
    super();
  }

  eq(other: PreviewWidget) {
    return other.source === this.source && other.taskId === this.taskId && other.from === this.from;
  }

  toDOM(view: EditorView) {
    const host = document.createElement('div');
    host.className = 'task-detail-block';
    this.root = createRoot(host);
    this.root.render(<BlockPreview source={this.source} taskId={this.taskId} from={this.from} handlers={this.handlers} />);
    queueMicrotask(() => view.requestMeasure());
    return host;
  }

  get estimatedHeight() {
    return 32;
  }

  destroy() {
    const root = this.root;
    this.root = null;
    if (root) queueMicrotask(() => root.unmount());
  }

  ignoreEvent() {
    return true;
  }
}

function BlockPreview({ source, taskId, from, handlers }: { source: string; taskId: string; from: number; handlers: Handlers }) {
  return <div onMouseDown={(event) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest('button, a')) return;
    event.preventDefault();
    handlers.edit(from);
  }} onContextMenu={(event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const image = target.closest('img');
    if (!(image instanceof HTMLImageElement)) return;
    const src = image.getAttribute('src');
    if (!src || !isTaskImageSrc(taskId, src)) return;
    event.preventDefault();
    handlers.zoom(src);
  }}>
    <MarkdownView content={source} components={{
      img: ({ src, alt }) => {
        const address = typeof src === 'string' ? src : undefined;
        if (!isTaskImageSrc(taskId, address)) return null;
        return <span className="task-image relative my-2 inline-block max-w-full">
          <img src={address} alt={typeof alt === 'string' ? alt : ''} className="block max-h-80 max-w-full rounded-lg" onLoad={() => handlers.remeasure()} />
          <span className="task-image-hint pointer-events-none absolute inset-x-0 bottom-2 justify-center">
            <span className="rounded-full bg-slate-950/75 px-2 py-0.5 text-xs text-white">右键放大</span>
          </span>
        </span>;
      },
    }} />
  </div>;
}

type PreviewState = { deco: DecorationSet; focused: boolean };

function buildPreview(state: EditorState, focused: boolean, taskId: string, handlers: Handlers) {
  const builder = new RangeSetBuilder<Decoration>();
  const source = state.doc.toString();
  const selection = state.selection.main;
  const editing = focused && state.facet(EditorView.editable);
  for (const block of markdownBlocks(source)) {
    if (block.from < 0 || block.to > source.length || block.from >= block.to) continue;
    if (editing && blockHoldsCaret(block, selection.from, selection.to)) continue;
    builder.add(block.from, block.to, Decoration.replace({
      widget: new PreviewWidget(source.slice(block.from, block.to), taskId, block.from, handlers),
      block: true,
    }));
  }
  return builder.finish();
}

// Block widgets have to come from a state field. View plugins supply decorations too late to replace lines.
function previewExtension(taskRef: { current: string }, handlersRef: { current: Handlers }) {
  const field = StateField.define<PreviewState>({
    create(state) {
      return { deco: buildPreview(state, false, taskRef.current, handlersRef.current), focused: false };
    },
    update(value, tr) {
      let focused = value.focused;
      let refresh = false;
      for (const effect of tr.effects) {
        if (effect.is(setFocused)) focused = effect.value;
        else if (effect.is(previewRefresh)) refresh = true;
      }
      const editableChanged = tr.state.facet(EditorView.editable) !== tr.startState.facet(EditorView.editable);
      if (!refresh && !editableChanged && focused === value.focused && !tr.docChanged && !tr.selection) {
        return { deco: value.deco.map(tr.changes), focused };
      }
      return { deco: buildPreview(tr.state, focused, taskRef.current, handlersRef.current), focused };
    },
    provide: (preview) => EditorView.decorations.from(preview, (value) => value.deco),
  });
  return [field, EditorView.focusChangeEffect.of((_state, focused) => setFocused.of(focused))];
}

function blockIsText(type: BlockType | readonly BlockInfo[]): boolean {
  if (Array.isArray(type)) return type.every((block) => blockIsText(block.type));
  return type === BlockType.Text;
}

// Playwright fill() replaces the DOM selection. A block widget or the empty-doc placeholder drops that mutation.
function shouldApplyInsert(view: EditorView, text: string) {
  if (!view.state.facet(EditorView.editable) || view.composing) return false;
  const { from, to } = view.state.selection.main;
  if (view.state.doc.length === 0) return text.length > 1;
  if (from === 0 && to === view.state.doc.length) return true;
  if (!blockIsText(view.lineBlockAt(from).type)) return true;
  return to !== from && !blockIsText(view.lineBlockAt(Math.min(view.state.doc.length, Math.max(from, to - 1))).type);
}

function applyTypedText(view: EditorView, text: string) {
  view.dispatch({
    ...view.state.changeByRange((range) => ({
      changes: { from: range.from, to: range.to, insert: text },
      range: EditorSelection.cursor(range.from + text.length),
    })),
    userEvent: 'input',
    scrollIntoView: true,
  });
}

function replaceDocument(view: EditorView, text: string) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: EditorSelection.cursor(text.length),
    userEvent: 'input',
    scrollIntoView: true,
  });
}

function rangeCoversContent(view: EditorView, startContainer: Node, startOffset: number, endContainer: Node, endOffset: number) {
  return startContainer === view.contentDOM && endContainer === view.contentDOM && startOffset === 0 && endOffset === view.contentDOM.childNodes.length;
}

const selectingDoc = new WeakSet<EditorView>();

function selectWholeDocument(view: EditorView) {
  if (selectingDoc.has(view) || !view.state.facet(EditorView.editable)) return;
  const selection = view.dom.ownerDocument.getSelection();
  if (!selection || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  let covers = rangeCoversContent(view, range.startContainer, range.startOffset, range.endContainer, range.endOffset);
  if (!covers && view.contentDOM.contains(range.commonAncestorContainer) && view.state.doc.length > 0) {
    try {
      covers = view.posAtDOM(range.startContainer, range.startOffset) === 0 && view.posAtDOM(range.endContainer, range.endOffset) === view.state.doc.length;
    } catch {
      covers = false;
    }
  }
  if (!covers) return;
  const next = EditorSelection.single(0, view.state.doc.length);
  if (view.state.selection.eq(next)) return;
  selectingDoc.add(view);
  try {
    view.dispatch({ selection: next, effects: setFocused.of(true), userEvent: 'select' });
  } finally {
    selectingDoc.delete(view);
  }
}

const editorTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'inherit', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.7', overflow: 'auto' },
  '.cm-content': { padding: '0.25rem 0', caretColor: 'currentColor' },
  '.cm-line': { padding: '0' },
  '.cm-placeholder': { color: 'var(--muted-foreground)' },
});

export function DescriptionEditor({ value, taskId, readonly, fill, openDescription, onChange, onBlur, onComposeStart, onComposeEnd, onPasteImages, onZoom, ref }: {
  value: string;
  taskId: string;
  readonly: boolean;
  fill: boolean;
  openDescription: { current: () => void };
  onChange: (value: string) => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
  onComposeStart: () => void;
  onComposeEnd: () => void;
  onPasteImages: (files: File[]) => void;
  onZoom: (src: string) => void;
  ref?: Ref<DescriptionHandle>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const onComposeStartRef = useRef(onComposeStart);
  const onComposeEndRef = useRef(onComposeEnd);
  const onPasteRef = useRef(onPasteImages);
  const readonlyRef = useRef(readonly);
  const taskRef = useRef(taskId);
  const composingRef = useRef(false);
  const handlersRef = useRef<Handlers>({ edit: () => {}, zoom: onZoom, remeasure: () => viewRef.current?.requestMeasure() });
  valueRef.current = value;
  onChangeRef.current = onChange;
  onBlurRef.current = onBlur;
  onComposeStartRef.current = onComposeStart;
  onComposeEndRef.current = onComposeEnd;
  onPasteRef.current = onPasteImages;
  readonlyRef.current = readonly;
  taskRef.current = taskId;
  handlersRef.current.zoom = onZoom;

  useImperativeHandle(ref, () => ({
    insert: (text) => { const view = viewRef.current; if (view) insertText(view, text); },
    blur: () => viewRef.current?.contentDOM.blur(),
    focus: () => viewRef.current?.focus(),
  }), []);

  useLayoutEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          history(),
          keymap.of([...historyKeymap, ...defaultKeymap]),
          placeholder('添加详情'),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': '详情' }),
          editorTheme,
          editableSlot.of(EditorView.editable.of(!readonlyRef.current)),
          previewExtension(taskRef, handlersRef),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const next = update.state.doc.toString();
            update.view.contentDOM.setAttribute('data-value', next);
            if (next === valueRef.current) return;
            valueRef.current = next;
            onChangeRef.current(next);
          }),
          EditorView.domEventHandlers({
            blur: (event, editor) => {
              const related = event.relatedTarget;
              if (related instanceof Element && related.closest('[data-description-tools]')) return true;
              onBlurRef.current({ currentTarget: editor.contentDOM, relatedTarget: related } as FocusEvent<HTMLElement>);
              return false;
            },
            compositionstart: () => { composingRef.current = true; onComposeStartRef.current(); return false; },
            compositionend: () => { composingRef.current = false; onComposeEndRef.current(); return false; },
            paste: (event) => takeFiles(event.clipboardData?.files, event),
            drop: (event) => takeFiles(event.dataTransfer?.files, event),
            dragover: (event) => {
              const items = [...(event.dataTransfer?.items ?? [])];
              if (!items.some((item) => item.kind === 'file')) return false;
              event.preventDefault();
              return true;
            },
          }),
        ],
      }),
    });
    view.contentDOM.setAttribute('data-value', valueRef.current);
    views.set(view.contentDOM, view);
    viewRef.current = view;
    let pointerButton = 0;
    const onMouseDown = (event: Event) => {
      if (!(event instanceof MouseEvent)) return;
      pointerButton = view.hasFocus ? 0 : event.button;
    };
    // Focus is synchronous inside Playwright fill(), and the block must already be source
    // before selectNodeContents runs. A right-click still has to keep the rendered image.
    const onFocus = () => {
      const button = pointerButton;
      pointerButton = 0;
      if (button !== 0 || !view.state.facet(EditorView.editable)) return;
      view.dispatch({ effects: setFocused.of(true) });
    };
    const onBeforeInput = (event: Event) => {
      if (!(event instanceof InputEvent) || event.inputType !== 'insertText' || composingRef.current) return;
      if (typeof event.data !== 'string') return;
      const covers = event.getTargetRanges?.().some((range) => rangeCoversContent(view, range.startContainer, range.startOffset, range.endContainer, range.endOffset)) ?? false;
      if (!covers && !shouldApplyInsert(view, event.data)) return;
      // A non-empty Android document already has its selection. preventDefault does not stop the insert there.
      if (/Android\b/.test(navigator.userAgent) && view.state.doc.length > 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (covers) replaceDocument(view, event.data);
      else applyTypedText(view, event.data);
    };
    const onSelectionChange = () => selectWholeDocument(view);
    view.contentDOM.addEventListener('mousedown', onMouseDown, true);
    view.contentDOM.addEventListener('focus', onFocus, true);
    view.contentDOM.addEventListener('beforeinput', onBeforeInput, true);
    // Bubble, registered after CodeMirror, so a select-all wins over its own mapping.
    view.dom.ownerDocument.addEventListener('selectionchange', onSelectionChange);
    handlersRef.current.edit = (pos) => {
      const length = view.state.doc.length;
      view.dispatch({
        selection: EditorSelection.cursor(Math.max(0, Math.min(pos, length))),
        effects: setFocused.of(true),
      });
      view.focus();
    };
    openDescription.current = () => { view.focus(); };
    return () => {
      openDescription.current = () => {};
      view.contentDOM.removeEventListener('mousedown', onMouseDown, true);
      view.contentDOM.removeEventListener('focus', onFocus, true);
      view.contentDOM.removeEventListener('beforeinput', onBeforeInput, true);
      view.dom.ownerDocument.removeEventListener('selectionchange', onSelectionChange);
      views.delete(view.contentDOM);
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
    function takeFiles(list: FileList | null | undefined, event: Event) {
      const images = [...(list ?? [])].filter((file) => file.type.startsWith('image/') && file.type !== 'image/svg+xml');
      if (!images.length || readonlyRef.current) return false;
      event.preventDefault();
      onPasteRef.current(images);
      return true;
    }
  }, [openDescription]);

  useLayoutEffect(() => {
    viewRef.current?.dispatch({ effects: editableSlot.reconfigure(EditorView.editable.of(!readonly)) });
  }, [readonly]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() !== value) {
      const head = view.state.selection.main.head;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: EditorSelection.cursor(Math.min(head, value.length)),
      });
    }
    view.contentDOM.setAttribute('data-value', value);
  }, [value]);

  useLayoutEffect(() => {
    viewRef.current?.dispatch({ effects: previewRefresh.of(null) });
  }, [taskId]);

  return <div ref={hostRef} className={cn('task-description-editor mt-1 min-h-20', fill && 'flex min-h-32 flex-1 flex-col')} />;
}
