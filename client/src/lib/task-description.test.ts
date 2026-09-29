import { describe, expect, it } from 'vitest';
import { codeFence, imageMarkdown, isTaskImageSrc, spliceText } from './task-description.js';

describe('task detail markdown helpers', () => {
  it('accepts only this task’s image address', () => {
    expect(isTaskImageSrc('task_1', '/api/tasks/task_1/images/img_1')).toBe(true);
    expect(isTaskImageSrc('task_1', 'https://evil.test/api/tasks/task_1/images/img_1')).toBe(false);
    expect(isTaskImageSrc('task_1', '//evil.test/api/tasks/task_1/images/img_1')).toBe(false);
    expect(isTaskImageSrc('task_1', '/api/tasks/other/images/img_1')).toBe(false);
    expect(isTaskImageSrc('task_1', '/api/tasks/task_1/images/img_1/extra')).toBe(false);
    expect(isTaskImageSrc('task_1', '/api/tasks/task_1/images/img_1?x=1')).toBe(false);
    expect(isTaskImageSrc('task_1', 'javascript:alert(1)')).toBe(false);
  });

  it('wraps a selection in a fence and puts the caret inside it', () => {
    const selected = 'const n = 1;';
    const fence = codeFence(selected);
    const next = spliceText('前文', 2, 2, fence.text);
    expect(next.value).toBe('前文```\nconst n = 1;\n```\n');
    expect(next.caret).toBe(2 + fence.text.length);
    const inside = next.caret - fence.text.length + fence.caret;
    expect(next.value.slice(inside - selected.length, inside)).toBe(selected);
    expect(next.value.slice(inside, inside + 1)).toBe('\n');
    expect(codeFence('```already')).toMatchObject({ text: '````\n```already\n````\n' });
  });

  it('inserts an image as a short markdown address', () => {
    const image = imageMarkdown('/api/tasks/task_1/images/img_1');
    expect(spliceText('说明', 2, 2, image.text)).toEqual({ value: '说明![](/api/tasks/task_1/images/img_1)\n', caret: 2 + image.caret });
  });
});
