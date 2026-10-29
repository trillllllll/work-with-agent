import { describe, expect, it } from 'vitest';
import { contextLabel, attachmentError, appendAssistantPrompt, suggestions, type ChatAttachment } from './assistant-context.js';
import { buildChatContext } from './chat-context.js';
import { applyMessageEvent } from '../chat.js';
describe('assistant context', () => {
  it('adds an explicit learning prompt without replacing the current draft', () => {
    expect(appendAssistantPrompt('', '  举个例子  ')).toBe('举个例子');
    expect(appendAssistantPrompt('我原来的问题', '考考我')).toBe('我原来的问题\n\n考考我');
    expect(appendAssistantPrompt('  保留原稿  ', ' ')).toBe('  保留原稿  ');
  });
  it('does not inherit a stale topic on workspace pages', () => {
    for (const page of ['settings', 'connections', 'runs', 'reviews', 'plan']) expect(buildChatContext({ page, topicId: 'stale', taskId: '' }).scope).toEqual({ kind: 'all' });
  });
  it('bounds display labels for task, material and list names without splitting emoji', () => {
    for (const label of ['任务 · ' + '长'.repeat(300), '资料 · ' + '长'.repeat(300), '清单'.repeat(400), '来源'.repeat(200)]) {
      expect(contextLabel(label)).toBe(label.slice(0, 300));
      expect(contextLabel(label).length).toBeLessThanOrEqual(300);
    }
    const label = 'a'.repeat(299) + '😀' + '原文';
    expect(contextLabel(label)).toBe('a'.repeat(299));
    expect(label).toBe('a'.repeat(299) + '😀原文');
    expect(contextLabel('a'.repeat(298) + '😀')).toBe('a'.repeat(298) + '😀');
    expect(contextLabel('普通标题')).toBe('普通标题');
  });
  it('counts Unicode code points and never silently clips attached text', () => {
    const item: ChatAttachment = { id: '1', kind: 'draft', title: '草稿', text: '😀'.repeat(20000), unsaved: true };
    expect(attachmentError([item])).toBe('');
    expect(attachmentError([item, item, { ...item, text: 'x' }])).toContain('40,000');
    expect(attachmentError([{ ...item, text: 'x'.repeat(20001) }])).toContain('20,000');
    expect(suggestions('plan')).toHaveLength(3);
  });
  it('replaces resumed source snapshots instead of appending stale versions', () => {
    const source = { kind: 'material' as const, id: 'm', title: '资料', revision: 1 };
    const messages = applyMessageEvent([{ id: 'a', role: 'assistant', content: '回答', sources: [source] }], { type: 'sources', messageId: 'a', sources: [{ ...source, revision: 2 }] });
    expect(messages[0].sources).toEqual([{ ...source, revision: 2 }]);
  });
  it('replaces only the matching optimistic user context with the server snapshot', () => {
    const context = buildChatContext({ page: 'inbox', topicId: '', taskId: 'a' });
    const rows = applyMessageEvent([{ id: 'old', role: 'user', content: '旧问题' }, { role: 'user', content: '新问题', context }], { type: 'user_context', messageId: 'new', context: { ...context, taskId: 'resolved' } });
    expect(rows[0]).toEqual({ id: 'old', role: 'user', content: '旧问题' });
    expect(rows[1]).toMatchObject({ id: 'new', context: { taskId: 'resolved' } });
  });

});
