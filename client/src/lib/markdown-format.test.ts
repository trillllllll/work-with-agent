import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { insertLink, prefixLines, wrapInline } from './markdown-format.js';

const st = (doc: string, from: number, to = from) =>
  EditorState.create({ doc, selection: EditorSelection.range(from, to) });

describe('wrapInline', () => {
  it('选区包裹 **', () => {
    const spec = wrapInline(st('hello', 0, 5), '**')!;
    const next = EditorState.create({ doc: 'hello' }).update(spec).state;
    expect(next.doc.toString()).toBe('**hello**');
    expect(next.selection.main.from).toBe(2); expect(next.selection.main.to).toBe(7);
  });
  it('再次包裹同一选区则解包', () => {
    const spec = wrapInline(st('**hello**', 2, 7), '**')!;
    expect(EditorState.create({ doc: '**hello**' }).update(spec).state.doc.toString()).toBe('hello');
  });
  it('选区两侧紧贴标记时解包两侧', () => {
    const spec = wrapInline(st('*ab*', 1, 3), '*')!;
    expect(EditorState.create({ doc: '*ab*' }).update(spec).state.doc.toString()).toBe('ab');
  });
  it('空选区返回 null', () => expect(wrapInline(st('hello', 2), '**')).toBeNull());
});

describe('prefixLines', () => {
  it('多行加 "- " 前缀', () => {
    const spec = prefixLines(st('a\nb\nc', 0, 5), '- ')!;
    expect(EditorState.create({ doc: 'a\nb\nc' }).update(spec).state.doc.toString()).toBe('- a\n- b\n- c');
  });
  it('全部已有前缀时移除', () => {
    const spec = prefixLines(st('- a\n- b', 0, 6), '- ')!;
    expect(EditorState.create({ doc: '- a\n- b' }).update(spec).state.doc.toString()).toBe('a\nb');
  });
  it('checklist 家族互通："- [x] " 行执行 "- [ ] " 是移除', () => {
    const spec = prefixLines(st('- [x] done', 0, 10), '- [ ] ')!;
    expect(EditorState.create({ doc: '- [x] done' }).update(spec).state.doc.toString()).toBe('done');
  });
});

describe('insertLink', () => {
  it('生成 [text](url) 且选中 url', () => {
    const spec = insertLink(st('点这里', 0, 3))!;
    const next = EditorState.create({ doc: '点这里' }).update(spec).state;
    expect(next.doc.toString()).toBe('[点这里](url)');
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe('url');
  });
});
