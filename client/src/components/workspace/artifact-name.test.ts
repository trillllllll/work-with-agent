import { describe, expect, it } from 'vitest';
import { downloadFileName, isMarkdownFile } from './artifact-name.js';

describe('artifact download name', () => {
  it('uses the filename inside the trailing parentheses', () => {
    expect(downloadFileName('grok_heavy 用量对比答案 (answer.md)')).toBe('answer.md');
  });

  it('keeps a name that already ends with an extension', () => {
    expect(downloadFileName('answer.md')).toBe('answer.md');
  });

  it('prefers the reported path basename', () => {
    expect(downloadFileName('说明', 'out/notes.md')).toBe('notes.md');
  });

  it('recognizes markdown filenames', () => {
    expect(isMarkdownFile(downloadFileName('grok_heavy 用量对比答案 (answer.md)'))).toBe(true);
    expect(isMarkdownFile('输出目录清单')).toBe(false);
  });
});
