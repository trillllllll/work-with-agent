import { createElement, Fragment, type MouseEvent as ReactMouseEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Bold, Code, Italic, Link2, List, ListTodo, Strikethrough, type LucideIcon } from 'lucide-react';
import { EditorState, StateEffect, StateField, type TransactionSpec } from '@codemirror/state';
import { EditorView, keymap, showTooltip, type Tooltip } from '@codemirror/view';
import { insertLink, prefixLines, wrapInline } from '@/lib/markdown-format.js';

const setFocused = StateEffect.define<boolean>();
type FormatRun = (state: EditorState) => TransactionSpec | null;

const buttons: { icon: LucideIcon; label: string; run: FormatRun }[] = [
  { icon: Bold, label: '加粗', run: (state) => wrapInline(state, '**') },
  { icon: Italic, label: '斜体', run: (state) => wrapInline(state, '*') },
  { icon: Strikethrough, label: '删除线', run: (state) => wrapInline(state, '~~') },
  { icon: Code, label: '行内代码', run: (state) => wrapInline(state, '`') },
  { icon: List, label: '无序列表', run: (state) => prefixLines(state, '- ') },
  { icon: ListTodo, label: '待办列表', run: (state) => prefixLines(state, '- [ ] ') },
  { icon: Link2, label: '插入链接', run: (state) => insertLink(state) },
];

function keepSelection(event: ReactMouseEvent) {
  event.preventDefault();
}

export function formatToolbar(getComposing: () => boolean) {
  const focusedField = StateField.define<boolean>({
    create: () => false,
    update(value, tr) {
      for (const effect of tr.effects) if (effect.is(setFocused)) return effect.value;
      return value;
    },
  });
  let editor: EditorView | null = null;
  const dispatch = (run: FormatRun) => {
    if (!editor) return;
    const spec = run(editor.state);
    if (spec) editor.dispatch(spec);
  };
  const create = (view: EditorView) => {
    editor = view;
    const host = document.createElement('div');
    host.className = 'cm-format-toolbar';
    host.setAttribute('role', 'toolbar');
    host.setAttribute('aria-label', '格式');
    host.addEventListener('mousedown', (event) => event.preventDefault());
    const mounted: Root = createRoot(host);
    mounted.render(createElement(FormatToolbar, { dispatch }));
    return { dom: host, destroy: () => queueMicrotask(() => mounted.unmount()) };
  };
  const tooltipField = StateField.define<Tooltip | null>({
    create: () => null,
    update(previous, tr) {
      const state = tr.state;
      let focused = tr.startState.field(focusedField, false) ?? false;
      for (const effect of tr.effects) if (effect.is(setFocused)) focused = effect.value;
      if (!state.facet(EditorView.editable) || !focused || getComposing()) return null;
      const range = state.selection.main;
      if (range.empty) return null;
      // fill() and select-all cover the whole document without scrollIntoView and would cover the title.
      // A keyboard line selection sets scrollIntoView, so a one-line document can still show the bar.
      const full = range.from === 0 && range.to === state.doc.length;
      if (full && !tr.scrollIntoView) {
        const before = tr.startState.selection.main;
        const same = !before.empty && before.from === range.from && before.to === range.to;
        if (!previous || !same) return null;
      }
      if (previous && previous.pos === range.from) return previous;
      return { pos: range.from, above: true, strictSide: true, arrow: false, create };
    },
  });
  return [
    focusedField,
    tooltipField,
    EditorView.focusChangeEffect.of((_, focused) => setFocused.of(focused)),
    showTooltip.compute([tooltipField], (state) => state.field(tooltipField)),
    keymap.of([
      { key: 'Mod-b', run: (view) => dispatchFormat(view, (state) => wrapInline(state, '**')) },
      { key: 'Mod-i', run: (view) => dispatchFormat(view, (state) => wrapInline(state, '*')) },
    ]),
  ];
}

function dispatchFormat(view: EditorView, run: FormatRun) {
  const spec = run(view.state);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
}

function FormatToolbar({ dispatch: apply }: { dispatch: (run: FormatRun) => void }) {
  return createElement(Fragment, null, buttons.map((button) => createElement('button', {
    key: button.label,
    type: 'button',
    'aria-label': button.label,
    title: button.label,
    className: 'grid size-7 place-items-center rounded-md text-foreground hover:bg-[var(--glass-hover)]',
    onMouseDown: keepSelection,
    onClick: () => apply(button.run),
  }, createElement(button.icon, { className: 'size-3.5', 'aria-hidden': true }))));
}
