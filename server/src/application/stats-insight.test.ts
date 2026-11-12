import { describe, expect, it, vi } from 'vitest';
import { statsInsight } from './stats-insight.js';
import type { AiSection, FocusSection, PlanSection, TasksSection } from './stats-overview.js';

// The insight cache is module-level and keyed by range, so every test that
// counts model calls gets its own range.
let rangeSeq = 0;
function freshRange() {
  rangeSeq += 1;
  const day = String(rangeSeq).padStart(2, '0');
  return { from: `2099-01-${day}`, to: `2099-01-${day}`, tz: 'Asia/Shanghai' };
}
const pair = (value = 0, previous = 0) => ({ value, previous });
const rate = (value: number | null = null) => ({ value, previous: null as number | null });

function emptyTasks(): TasksSection {
  return { completedByDay: [], createdByDay: [], created: pair(), completed: pair(), overdue: 0, overdueTop: [], overdueOldestDays: 0, byTopic: [], byTag: [], estimatedCount: pair() };
}
function busyTasks(): TasksSection {
  return {
    ...emptyTasks(),
    completed: pair(18, 15), created: pair(22, 20), overdue: 3, overdueOldestDays: 5,
    overdueTop: [{ id: 't0', title: '报销发票', topicId: null, topicName: null, topicColor: null, days: 5 }],
    byTopic: [{ topicId: 'tp1', name: '报销', color: '#000000', count: 6 }],
  };
}
function emptyFocus(): FocusSection {
  return { minutesByDay: [], sessionsByDay: [], minutes: pair(), sessions: pair(), completedSessions: pair(), avgSession: rate(), completionRate: rate(), byTask: [] };
}
function busyFocus(): FocusSection {
  return { ...emptyFocus(), minutes: pair(570, 480), sessions: pair(12, 10), avgSession: rate(47.5), byTask: [{ taskId: 't1', title: '写周报', minutes: 120, sessions: 3 }] };
}
function emptyPlan(): PlanSection {
  return { byDay: [], onPlanRate: rate(), plannedTasks: pair(), doneOnPlanTasks: pair(), plannedMinutesTotal: pair(), focusMinutesTotal: pair(), byBand: [] };
}
function busyPlan(): PlanSection {
  return { ...emptyPlan(), onPlanRate: rate(0.61), plannedTasks: pair(18, 20), doneOnPlanTasks: pair(11, 12), plannedMinutesTotal: pair(900, 960), focusMinutesTotal: pair(570, 480) };
}
function emptyAi(): AiSection {
  return {
    proposals: { created: pair(), executed: pair(), rejected: pair(), failed: pair(), pending: 0, adoptionRate: rate(), bySource: [] },
    memories: { created: pair(), retired: pair(), byOrigin: { manual: 0, ai: 0 }, activeTotal: 0 },
    autoMemory: { jobs: pair(), failed: pair(), adoption: rate() },
    dispatch: { rounds: pair(), firstPassRate: rate(), costMicroUsd: pair(), byDay: [] },
    connections: [],
  };
}
function busyAi(): AiSection {
  return { ...emptyAi(), proposals: { ...emptyAi().proposals, created: pair(41, 38), executed: pair(32, 30), rejected: pair(9, 8), pending: 2, adoptionRate: rate(0.78) }, dispatch: { ...emptyAi().dispatch, rounds: pair(14, 11), firstPassRate: rate(0.86) } };
}

type ModelMessages = Array<{ role: 'system' | 'user'; content: string }>;

const GOOD_JSON = JSON.stringify({
  headline: '近 7 天完成 18 项（↑23%），3 项逾期需要处理。',
  notes: [
    { tone: 'warn', label: '逾期', text: '报销相关 3 项逾期超 5 天，建议批量处理。' },
    { tone: 'info', label: '规律', text: '专注投入集中在写周报。' },
    { tone: 'whatever', label: '建议', text: '计划量可以下调。' },
    { tone: 'idea', label: '', text: '' },
  ],
  extra: 'ignored',
});

function depsWith(overrides: Partial<Parameters<typeof statsInsight>[1]> = {}) {
  return {
    now: new Date('2099-03-08T06:32:00Z'),
    tasks: async () => busyTasks(),
    focus: async () => busyFocus(),
    plan: async () => busyPlan(),
    ai: async () => busyAi(),
    model: { complete: vi.fn(async (_messages: ModelMessages) => ({ text: GOOD_JSON })) },
    ...overrides,
  };
}

describe('statsInsight', () => {
  it('empty workspace resolves sparse without calling the model', async () => {
    const model = { complete: vi.fn(async (_messages: ModelMessages) => ({ text: GOOD_JSON })) };
    const deps = depsWith({ model, tasks: async () => emptyTasks(), focus: async () => emptyFocus(), plan: async () => emptyPlan(), ai: async () => emptyAi() });
    const result = await statsInsight(freshRange(), deps);
    expect(result).toEqual({ insight: null, reason: 'sparse' });
    expect(model.complete).not.toHaveBeenCalled();
  });

  it('parses the model JSON, clamps fields and defaults unknown tones to info', async () => {
    const result = await statsInsight(freshRange(), depsWith());
    expect(result.reason).toBeUndefined();
    expect(result.generatedAt).toBe('2099-03-08T06:32:00.000Z');
    expect(result.insight?.headline).toContain('18 项');
    expect(result.insight?.notes).toHaveLength(3);
    expect(result.insight?.notes[2]?.tone).toBe('info');
    expect(result.insight?.notes.every((note) => note.text.length > 0)).toBe(true);
  });

  it('sends a compact digest with the key numbers', async () => {
    const model = { complete: vi.fn(async (_messages: ModelMessages) => ({ text: GOOD_JSON })) };
    await statsInsight(freshRange(), depsWith({ model }));
    const messages = model.complete.mock.calls[0]![0];
    expect(String(messages[0]?.content)).toContain('[统计洞察]');
    const digest = String(messages[1]?.content);
    expect(digest).toContain('"本期完成":18');
    expect(digest).toContain('"逾期":3');
    expect(digest).toContain('"按时完成率":61');
    expect(digest).toContain('"采纳率":78');
    expect(digest).not.toContain('byDay');
  });

  it('serves the same range from cache until refreshed', async () => {
    const range = freshRange();
    const model = { complete: vi.fn(async (_messages: ModelMessages) => ({ text: GOOD_JSON })) };
    const deps = depsWith({ model });
    const first = await statsInsight(range, deps);
    const second = await statsInsight(range, deps);
    expect(second.insight).toEqual(first.insight);
    expect(model.complete).toHaveBeenCalledTimes(1);
    const refreshed = await statsInsight(range, { ...deps, refresh: true });
    expect(refreshed.insight).toEqual(first.insight);
    expect(model.complete).toHaveBeenCalledTimes(2);
  });

  it('joins an in-flight generation for the same range', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const range = freshRange();
    const model = { complete: vi.fn(async (_messages: ModelMessages) => { await gate; return { text: GOOD_JSON }; }) };
    const deps = depsWith({ model });
    const first = statsInsight(range, deps);
    const second = statsInsight(range, deps);
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(left.insight).toEqual(right.insight);
    expect(model.complete).toHaveBeenCalledTimes(1);
  });

  it('unconfigured model resolves no-model', async () => {
    const deps = depsWith({ model: { complete: vi.fn(async () => { throw new Error('未配置模型服务'); }) } });
    expect(await statsInsight(freshRange(), deps)).toEqual({ insight: null, reason: 'no-model' });
  });

  it('unusable model output resolves failed', async () => {
    const deps = depsWith({ model: { complete: vi.fn(async () => ({ text: '好的，以下是分析：……（没有 JSON）' })) } });
    expect(await statsInsight(freshRange(), deps)).toEqual({ insight: null, reason: 'failed' });
  });

  it('model network failure resolves failed', async () => {
    const deps = depsWith({ model: { complete: vi.fn(async () => { throw new Error('模型网络请求失败'); }) } });
    expect(await statsInsight(freshRange(), deps)).toEqual({ insight: null, reason: 'failed' });
  });

  it('every section failing resolves failed without calling the model', async () => {
    const boom = async () => { throw new Error('boom'); };
    const model = { complete: vi.fn(async (_messages: ModelMessages) => ({ text: GOOD_JSON })) };
    const deps = depsWith({ model, tasks: boom, focus: boom, plan: boom, ai: boom });
    expect(await statsInsight(freshRange(), deps)).toEqual({ insight: null, reason: 'failed' });
    expect(model.complete).not.toHaveBeenCalled();
  });

  it('survives one section failing and analyzes the rest', async () => {
    const focus = async () => { throw new Error('boom'); };
    const model = { complete: vi.fn(async (_messages: ModelMessages) => ({ text: GOOD_JSON })) };
    const result = await statsInsight(freshRange(), depsWith({ model, focus }));
    expect(result.insight?.headline).toContain('18 项');
    const digest = String(model.complete.mock.calls[0]![0][1]?.content ?? '');
    expect(digest).toContain('"任务":');
    expect(digest).not.toContain('"专注":');
  });

  it('rejects an invalid range', async () => {
    await expect(statsInsight({ from: '2099-03-07', to: '2099-03-01', tz: 'UTC' }, depsWith())).rejects.toMatchObject({ code: 'INVALID_STATS_RANGE' });
  });
});
