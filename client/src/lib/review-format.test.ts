import { describe, expect, it } from 'vitest';
import type { Topic } from './api.js';
import { classifyScope, formatInZone, latestBatchByRule, localizeIsoTimes, needsAttention, sortRules, weekdayOrder } from './review-format.js';

function topic(id: string, name: string, archivedAt: string | null = null): Topic {
  return { id, name, description: '', color: 'slate', isExploration: false, archivedAt };
}

describe('review format', () => {
  it('orders weekdays Monday through Sunday and keeps 0 as Sunday', () => {
    expect(weekdayOrder).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(weekdayOrder.indexOf(5)).toBe(4);
    expect(weekdayOrder[weekdayOrder.length - 1]).toBe(0);
  });

  it('puts enabled failures first, other enabled rules next, and paused rules last', () => {
    const rules = [
      { id: 'paused-failed', enabled: false },
      { id: 'ready', enabled: true },
      { id: 'failed', enabled: true },
      { id: 'paused', enabled: false },
      { id: 'partial', enabled: true },
    ];
    const latest = new Map([
      ['paused-failed', { status: 'failed' }],
      ['ready', { status: 'ready' }],
      ['failed', { status: 'failed' }],
      ['partial', { status: 'partial' }],
    ]);
    expect(sortRules(rules, latest).map((rule) => rule.id)).toEqual(['failed', 'ready', 'partial', 'paused-failed', 'paused']);
  });

  it('keeps the newest batch for each rule', () => {
    const batches = [
      { ruleId: 'a', createdAt: '2026-10-01T00:00:00.000Z', id: 'old' },
      { ruleId: 'a', createdAt: '2026-10-02T00:00:00.000Z', id: 'new' },
      { ruleId: 'b', createdAt: '2026-10-03T00:00:00.000Z', id: 'b1' },
      { ruleId: 'a', createdAt: '2026-10-02T00:00:00.000Z', id: 'tie' },
    ];
    const latest = latestBatchByRule(batches);
    expect(latest.get('a')?.id).toBe('new');
    expect(latest.get('b')?.id).toBe('b1');
  });

  it('treats partial, failed, and generating batches as needing attention', () => {
    expect(needsAttention({ status: 'partial' })).toBe(true);
    expect(needsAttention({ status: 'failed' })).toBe(true);
    expect(needsAttention({ status: 'generating' })).toBe(true);
    expect(needsAttention({ status: 'ready' })).toBe(false);
  });

  it('classifies active, archived, and missing lists, and does not report missing lists before archives load', () => {
    const live = topic('live', '进行中');
    const old = topic('old', '已归档', '2026-01-01T00:00:00.000Z');
    const loaded = classifyScope(['live', 'old', 'gone'], [live], [old], true);
    expect(loaded.active).toEqual([live]);
    expect(loaded.archived).toEqual([old]);
    expect(loaded.missingIds).toEqual(['gone']);
    const unloaded = classifyScope(['live', 'old', 'gone'], [live], [], false);
    expect(unloaded).toEqual({ active: [live], archived: [], missingIds: [] });
  });

  it('replaces ISO timestamps in Asia/Shanghai and leaves the rest of the markdown unchanged', () => {
    const iso = '2026-10-18T13:00:00.000Z';
    const later = '2026-10-19T01:30:00.000Z';
    const locale = 'zh-CN';
    const zone = 'Asia/Shanghai';
    const format = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }).format(new Date(value));
    const markdown = `# 回顾\n\n覆盖 ${iso} 至 ${later}（Asia/Shanghai）\n\n- 新增：2\n- 不是时间：2026-10-18 21:00\n- 无毫秒：2026-10-18T13:00:00Z\n`;
    expect(localizeIsoTimes(markdown, locale, zone)).toBe(markdown.replace(iso, format(iso)).replace(later, format(later)));
    expect(formatInZone(iso, locale, zone)).toBe(format(iso));
  });
});
