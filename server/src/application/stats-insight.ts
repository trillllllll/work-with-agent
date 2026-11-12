/**
 * Owner stats insight: one LLM commentary per range for the banner on the stats
 * page. Every non-happy path resolves to `{ insight: null, reason }` with HTTP
 * 200 so the banner can choose between hiding (sparse, no model) and offering a
 * retry (failed); only an invalid range throws.
 *
 * The cache is in-memory on purpose: insights are derived commentary, the range
 * set is small, and a table would add a migration for data we can regenerate.
 * Same-range requests that arrive while a generation is in flight share it.
 */
import { MemoryModelAdapter, type MemoryCompletion } from './auto-memory-model.js';
import { loadAi, loadFocus, loadPlan, loadTasks, parseOverviewQuery, type AiSection, type FocusSection, type OverviewRange, type PlanSection, type TasksSection } from './stats-overview.js';

export type StatsInsightNote = { tone: 'warn' | 'info' | 'idea'; label: string; text: string };
export type StatsInsightPayload = { headline: string; notes: StatsInsightNote[] };
export type StatsInsightResult = {
  insight: StatsInsightPayload | null;
  reason?: 'sparse' | 'no-model' | 'failed';
  generatedAt?: string;
};

type InsightModel = { complete(messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<MemoryCompletion> };

const INSIGHT_TTL_MS = 60 * 60 * 1000;
const INSIGHT_CACHE_MAX = 24;
const MAX_NOTES = 4;
const cache = new Map<string, { payload: StatsInsightPayload; generatedAt: string }>();
const inflight = new Map<string, Promise<StatsInsightResult>>();

const SYSTEM_PROMPT = [
  '[统计洞察] 你是任务工作台的统计分析师，只根据给出的数字写分析，不编造数据。',
  '只输出一个 JSON 对象，格式：',
  '{"headline":"一句话结论（不超过60字，结论先行，带关键数字对比）","notes":[{"tone":"warn|info|idea","label":"不超过6字的小标题","text":"不超过80字的说明"}]}',
  'notes 给 2-3 条：tone=warn 是需要行动的问题，info 是规律或发现，idea 是建议；没有把握的不要写。',
].join('\n');

/** Compact number-only digest. Series arrays stay out; the model never needs them. */
function buildDigest(range: OverviewRange, tasks: TasksSection | null, focus: FocusSection | null, plan: PlanSection | null, ai: AiSection | null) {
  const percent = (value: number | null) => value == null ? null : Math.round(value * 100);
  const digest: Record<string, unknown> = {
    区间: { 开始: range.from, 结束: range.to, 天数: range.days, 今天: range.today },
  };
  if (tasks) {
    digest['任务'] = {
      本期完成: tasks.completed.value, 上期完成: tasks.completed.previous, 本期新增: tasks.created.value,
      逾期: tasks.overdue, 逾期最久天数: tasks.overdueOldestDays,
      逾期最久: tasks.overdueTop.slice(0, 3).map((row) => ({ 标题: row.title, 清单: row.topicName, 逾期天数: row.days })),
      完成最多清单: tasks.byTopic.slice(0, 3).map((row) => ({ 名称: row.name ?? '收集箱', 数量: row.count })),
      完成最多标签: tasks.byTag.slice(0, 3).map((row) => ({ 名称: row.name, 数量: row.count })),
    };
  }
  if (focus) {
    digest['专注'] = {
      本期分钟: focus.minutes.value, 上期分钟: focus.minutes.previous, 次数: focus.sessions.value,
      平均每次分钟: focus.avgSession.value == null ? null : Math.round(focus.avgSession.value),
      投入最多任务: focus.byTask.slice(0, 3).map((row) => ({ 标题: row.title ?? '自由专注', 分钟: row.minutes, 次数: row.sessions })),
    };
  }
  if (plan) {
    digest['规划'] = {
      本期计划任务数: plan.plannedTasks.value, 按时完成率: percent(plan.onPlanRate.value), 按时完成任务: plan.doneOnPlanTasks.value,
      计划分钟: plan.plannedMinutesTotal.value, 专注分钟: plan.focusMinutesTotal.value,
    };
  }
  if (ai) {
    digest['AI'] = {
      提议新增: ai.proposals.created.value, 已采纳: ai.proposals.executed.value, 已拒绝: ai.proposals.rejected.value, 待确认: ai.proposals.pending,
      采纳率: percent(ai.proposals.adoptionRate.value), 派发轮次: ai.dispatch.rounds.value,
      一次通过率: percent(ai.dispatch.firstPassRate.value), 活跃记忆数: ai.memories.activeTotal,
    };
  }
  return digest;
}

function positive(value: number | null | undefined) { return typeof value === 'number' && value > 0; }

/** Same verdict as the client's workspaceIsEmpty, minus assistantUsage: chat-only workspaces stay quiet here. */
function sectionsAreEmpty(tasks: TasksSection | null, focus: FocusSection | null, plan: PlanSection | null, ai: AiSection | null): boolean {
  if (tasks && (positive(tasks.completed.value) || positive(tasks.created.value) || tasks.overdue > 0 || positive(tasks.estimatedCount.value) || tasks.byTopic.length > 0 || tasks.byTag.length > 0 || tasks.overdueTop.length > 0)) return false;
  if (focus && (positive(focus.minutes.value) || positive(focus.sessions.value) || focus.byTask.length > 0)) return false;
  if (plan && (positive(plan.plannedTasks.value) || positive(plan.plannedMinutesTotal.value) || positive(plan.focusMinutesTotal.value))) return false;
  if (ai) {
    if (positive(ai.proposals.created.value) || positive(ai.proposals.executed.value) || positive(ai.proposals.rejected.value) || positive(ai.proposals.failed.value) || ai.proposals.pending > 0) return false;
    if (positive(ai.memories.created.value) || positive(ai.memories.retired.value) || positive(ai.memories.activeTotal) || positive(ai.dispatch.rounds.value)) return false;
  }
  return true;
}

function parseInsight(text: string): StatsInsightPayload | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const raw = parsed as { headline?: unknown; notes?: unknown };
  const headline = typeof raw.headline === 'string' ? raw.headline.trim().slice(0, 120) : '';
  if (!headline) return null;
  const notes = Array.isArray(raw.notes) ? raw.notes : [];
  const cleaned: StatsInsightNote[] = [];
  for (const note of notes.slice(0, MAX_NOTES)) {
    if (!note || typeof note !== 'object' || Array.isArray(note)) continue;
    const item = note as { tone?: unknown; label?: unknown; text?: unknown };
    const textLine = typeof item.text === 'string' ? item.text.trim().slice(0, 200) : '';
    if (!textLine) continue;
    const tone = item.tone === 'warn' || item.tone === 'idea' ? item.tone : 'info';
    cleaned.push({ tone, label: typeof item.label === 'string' ? item.label.trim().slice(0, 12) : '', text: textLine });
  }
  return { headline, notes: cleaned };
}

export type StatsInsightDeps = {
  now?: Date;
  model?: InsightModel;
  tasks?: (range: OverviewRange) => Promise<TasksSection>;
  focus?: (range: OverviewRange) => Promise<FocusSection>;
  plan?: (range: OverviewRange) => Promise<PlanSection>;
  ai?: (range: OverviewRange) => Promise<AiSection>;
};

function cacheKey(range: Pick<OverviewRange, 'from' | 'to' | 'tz'>) { return `${range.from}|${range.to}|${range.tz}`; }

export async function statsInsight(query: { from: string; to: string; tz: string }, options: { refresh?: boolean } & StatsInsightDeps = {}): Promise<StatsInsightResult> {
  const range = parseOverviewQuery(query, options.now);
  const key = cacheKey(range);
  if (!options.refresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - Date.parse(hit.generatedAt) < INSIGHT_TTL_MS) return { insight: hit.payload, generatedAt: hit.generatedAt };
  }
  const pending = inflight.get(key);
  if (pending && !options.refresh) return pending;
  const run = (async (): Promise<StatsInsightResult> => {
    const [tasks, focus, plan, ai] = await Promise.allSettled([
      (options.tasks ?? loadTasks)(range),
      (options.focus ?? loadFocus)(range),
      (options.plan ?? loadPlan)(range),
      (options.ai ?? loadAi)(range),
    ]);
    const settled = [tasks, focus, plan, ai].map((result) => result.status === 'fulfilled' ? result.value : null);
    if (settled.every((section) => section == null)) return { insight: null, reason: 'failed' };
    const [taskSection, focusSection, planSection, aiSection] = settled as [TasksSection | null, FocusSection | null, PlanSection | null, AiSection | null];
    if (sectionsAreEmpty(taskSection, focusSection, planSection, aiSection)) return { insight: null, reason: 'sparse' };
    const digest = buildDigest(range, taskSection, focusSection, planSection, aiSection);
    let completion: MemoryCompletion;
    try {
      completion = await (options.model ?? new MemoryModelAdapter()).complete([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(digest) },
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('未配置模型')) return { insight: null, reason: 'no-model' };
      console.error(`[stats-insight] model call failed: ${message}`);
      return { insight: null, reason: 'failed' };
    }
    const payload = parseInsight(completion.text);
    if (!payload) {
      console.error('[stats-insight] model returned unusable JSON');
      return { insight: null, reason: 'failed' };
    }
    const generatedAt = (options.now ?? new Date()).toISOString();
    cache.delete(key);
    cache.set(key, { payload, generatedAt });
    while (cache.size > INSIGHT_CACHE_MAX) cache.delete(cache.keys().next().value!);
    return { insight: payload, generatedAt };
  })();
  if (!options.refresh) inflight.set(key, run);
  try {
    return await run;
  } finally {
    if (!options.refresh) inflight.delete(key);
  }
}
