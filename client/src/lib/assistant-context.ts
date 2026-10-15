import { useLayoutEffect, useSyncExternalStore } from 'react';
import type { ChatContextV3, ChatAttachment } from '../../../server/src/agent/chat-context.js';
export type { ChatContextV3, ChatAttachment };

export const pageNames: Record<string, string> = { inbox: '收集箱', board: '清单', today: '今天', plan: '规划', search: '搜索', tags: '标签', library: '资料库', knowledge: '工作上下文', topics: '清单', quadrant: '四象限', archived: '已归档', trash: '回收站', focus: '专注', settings: '设置', connections: '连接', proposals: '提议', changes: '变更历史', runs: '运行', reviews: '定期回顾', more: '更多' };
type PublishedContext = { page: string; value: Partial<ChatContextV3> };
const pages = new Map<string, PublishedContext>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, PublishedContext> = new Map();
function notify() { snapshot = new Map(pages); listeners.forEach((listener) => listener()); }
export function usePageContext(page: string, value: Partial<ChatContextV3>) {
  const serialized = JSON.stringify(value);
  useLayoutEffect(() => {
    const entry = { page, value: JSON.parse(serialized) as Partial<ChatContextV3> };
    pages.set(page, entry); notify();
    return () => { if (pages.get(page) === entry) { pages.delete(page); notify(); } };
  }, [page, serialized]);
}
export function usePageContexts() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot);
}
export function attachmentError(items: ChatAttachment[]) {
  if (items.length > 20) return '每条消息最多添加 20 个附件';
  if (items.some((item) => [...item.text].length > 20000)) return '单个附件最多 20,000 字符，请缩小选择范围';
  if (items.reduce((sum, item) => sum + [...item.text].length, 0) > 40000) return '附件合计最多 40,000 字符，请移除部分附件';
  return '';
}
export function askAssistant(attachment?: Omit<ChatAttachment, 'id'>) {
  window.dispatchEvent(new CustomEvent('wwa-open-assistant', { detail: attachment ? { attachment: { ...attachment, id: crypto.randomUUID() } } : {} }));
}
export function suggestions(page: string): string[] {
  if (page === 'plan') return ['帮我检查这段时间的安排', '哪些任务还没有安排时间？', '规划页面怎么用？'];
  if (page === 'library') return ['总结当前资料的重点', '找找其他相关资料', '资料库可以做什么？'];
  if (page === 'settings' || page === 'connections') return ['这个页面怎么用？', '应用支持哪些 AI 能力？', '如何配置模型连接？'];
  return ['帮我梳理当前工作的重点', '找找相关任务和资料', '这个页面怎么用？'];
}
