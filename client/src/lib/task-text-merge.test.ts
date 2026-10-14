import { describe, expect, it } from 'vitest';
import { mergeText } from './task-text-merge.js';

describe('mergeText', () => {
  const base = {
    revision: 1,
    title: '旧标题',
    description: '旧正文',
  };

  it('不同字段各自修改时自动合并', () => {
    const result = mergeText(
      base,
      { title: '我的标题', description: '旧正文' },
      { revision: 2, title: '旧标题', description: '远端正文' },
    );

    expect(result.draft).toEqual({
      title: '我的标题',
      description: '远端正文',
    });
    expect(result.conflicts).toEqual({});
  });

  it('同一正文冲突时保留本地和远端两份内容', () => {
    const result = mergeText(
      base,
      { title: '旧标题', description: '本地正文' },
      { revision: 2, title: '旧标题', description: '远端正文' },
    );

    expect(result.draft.description).toBe('本地正文');
    expect(result.conflicts.description).toEqual({
      base: '旧正文',
      local: '本地正文',
      remote: '远端正文',
      remoteRevision: 2,
    });
  });

  it('两端已经写成相同内容时不报冲突', () => {
    const result = mergeText(
      base,
      { title: '旧标题', description: '相同正文' },
      { revision: 2, title: '旧标题', description: '相同正文' },
    );

    expect(result.conflicts).toEqual({});
  });

  it('正文末尾空白不能被 trim', () => {
    const result = mergeText(
      base,
      { title: '旧标题', description: '旧正文\n\n' },
      base,
    );

    expect(result.draft.description).toBe('旧正文\n\n');
  });
});
