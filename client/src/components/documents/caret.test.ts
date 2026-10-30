import { describe, expect, it } from 'vitest';
import { changedRange } from './caret.js';

describe('changed text range', () => {
  it('locates insertions, deletions and repeated text in the new value', () => {
    expect(changedRange('abc', 'abXc')).toEqual({ from: 2, to: 3 });
    expect(changedRange('abXc', 'abc')).toEqual({ from: 2, to: 2 });
    expect(changedRange('aaa', 'aaaa')).toEqual({ from: 3, to: 4 });
    expect(changedRange('line one\nline two', 'line one\nline two\nline three')).toEqual({ from: 17, to: 28 });
    expect(changedRange('same', 'same')).toEqual({ from: 4, to: 4 });
  });

  it('never splits a surrogate pair', () => {
    expect(changedRange('\uD83D\uDE00', '\uD83D\uDE03')).toEqual({ from: 0, to: 2 });
    expect(changedRange('x\uD83D\uDE00y', 'x\uD83D\uDE03y')).toEqual({ from: 1, to: 3 });
  });
});
