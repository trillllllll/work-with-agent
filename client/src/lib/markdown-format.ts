import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';

const input = { userEvent: 'input' as const, scrollIntoView: true };

export function wrapInline(state: EditorState, marker: string): TransactionSpec | null {
  const range = state.selection.main;
  if (range.empty) return null;
  const m = marker.length;
  const text = state.sliceDoc(range.from, range.to);
  const before = state.sliceDoc(Math.max(0, range.from - m), range.from);
  const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + m));
  if (text.length >= m * 2 && text.startsWith(marker) && text.endsWith(marker)) {
    const inner = text.slice(m, -m);
    return { ...input, changes: { from: range.from, to: range.to, insert: inner }, selection: EditorSelection.range(range.from, range.from + inner.length) };
  }
  if (before === marker && after === marker) {
    return {
      ...input,
      changes: [{ from: range.from - m, to: range.from }, { from: range.to, to: range.to + m }],
      selection: EditorSelection.range(range.from - m, range.to - m),
    };
  }
  return { ...input, changes: { from: range.from, to: range.to, insert: marker + text + marker }, selection: EditorSelection.range(range.from + m, range.to + m) };
}

const CHECK_FAMILY: Record<string, string[]> = { '- [ ] ': ['- [ ] ', '- [x] ', '- [X] '] };

export function prefixLines(state: EditorState, prefix: string): TransactionSpec | null {
  const matches = CHECK_FAMILY[prefix] ?? [prefix];
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(range.to);
  const lines = [];
  for (let number = first.number; number <= last.number; number += 1) lines.push(state.doc.line(number));
  const allHave = lines.every((line) => line.text === '' || matches.some((item) => line.text.startsWith(item)));
  const changes: { from: number; to: number; insert?: string }[] = [];
  for (const line of lines) {
    const hit = matches.find((item) => line.text.startsWith(item));
    if (allHave) {
      if (hit) changes.push({ from: line.from, to: line.from + hit.length });
    } else if (line.text.trim() !== '' && !hit) {
      changes.push({ from: line.from, to: line.from, insert: prefix });
    }
  }
  if (!changes.length) return null;
  return { changes, userEvent: 'input', scrollIntoView: true };
}

export function insertLink(state: EditorState): TransactionSpec {
  const range = state.selection.main;
  const text = state.sliceDoc(range.from, range.to);
  const display = text.length === 0 ? '链接' : text;
  const urlStart = range.from + 1 + display.length + 2;
  return { ...input, changes: { from: range.from, to: range.to, insert: `[${display}](url)` }, selection: EditorSelection.range(urlStart, urlStart + 3) };
}
