import { describe, expect, it } from 'vitest';
import { readCollapsedParents, toggleCollapsedParent, writeCollapsedParents } from './task-collapse.js';

const memory = (initial?: string) => {
  const map = new Map(initial ? [['todo.collapsedParents', initial]] : []);
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    read: () => map.get('todo.collapsedParents') ?? null,
  };
};

describe('readCollapsedParents', () => {
  it('returns an empty list for missing keys, invalid JSON and non-array values', () => {
    expect(readCollapsedParents(memory())).toEqual([]);
    expect(readCollapsedParents(memory('{oops'))).toEqual([]);
    expect(readCollapsedParents(memory('{"a":1}'))).toEqual([]);
  });

  it('keeps only strings and dedupes', () => {
    expect(readCollapsedParents(memory('["a",2,"a",null,"b"]'))).toEqual(['a', 'b']);
  });
});

describe('writeCollapsedParents', () => {
  it('round-trips through storage', () => {
    const storage = memory();
    writeCollapsedParents(['a', 'b'], storage);
    expect(readCollapsedParents(storage)).toEqual(['a', 'b']);
  });
});

describe('toggleCollapsedParent', () => {
  it('adds and removes without mutating the input', () => {
    const ids = ['a'];
    expect(toggleCollapsedParent(ids, 'b')).toEqual(['a', 'b']);
    expect(toggleCollapsedParent(ids, 'a')).toEqual([]);
    expect(ids).toEqual(['a']);
  });
});
