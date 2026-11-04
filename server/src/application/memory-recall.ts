// 记忆召回核心（docs/2026-11-04_memory-recall-plan.md 5.2–5.4）。
// 常驻记忆：约束类与最高重要度，按预算装填，只由记忆数据决定。
// 相关记忆：按当前问题排序召回；简单回复跳过检索；全部放得下时全放。
// 字数口径一律按码点（codePointLength），与 codePoints 一致。
import { prisma } from '../infrastructure/prisma.js';
import { readLabels } from './knowledge.js';
import { codePointLength, normalizeQuery } from './library/text.js';

// 第 6 节常量表（冻结）：修改任何数值必须先跑第 8 节评测并写进第 11 节。
export const CORE_BUDGET = 600;
export const CORE_TITLE_CLIP = 60;
export const CORE_CONTENT_CLIP = 80;
export const RECALL_BUDGET = 1200;
export const RECALL_TOP_K = 5;
export const RECALL_TITLE_CLIP = 60;
export const RECALL_CONTENT_CLIP = 240;
export const RECALL_QUERY_CHARS = 300;
export const RECALL_MIN_HITS = 2;
// 2026-11-05 修订（第 11 节）：中文 2 字片段与标题索引。
export const RECALL_BIGRAM_WEIGHT = 0.5;
export const RECALL_MIN_BIGRAM_HITS = 2;
export const RECALL_MIN_SCORE_RATIO = 0.2;
export const RECALL_INDEX_BUDGET = 500;
export const RECALL_INDEX_TITLE_CLIP = 30;
/** 高频虚词组合，不作为 2 字检索片段。 */
export const STOP_BIGRAMS = new Set([
  '什么', '怎么', '怎样', '为什', '么样', '是不', '不是', '我们', '你们', '他们', '这个', '那个', '这些', '那些',
  '一下', '一个', '有没', '没有', '可以', '现在', '时候', '之前', '之后', '如何', '哪些', '哪个', '还是', '就是',
  '但是', '因为', '所以', '如果', '是否', '能不', '不能', '应该', '需要', '一般', '这边', '那边', '这块', '东西',
  '一起', '的时', '候的', '了吗', '的吗', '是什', '么的', '有什', '么规', '要怎', '该怎', '么做', '么办',
]);
export const TRIVIAL_PATTERN = /^(好的?|嗯+|ok|okay|谢谢|多谢|thanks?|thx|收到|可以|行|是的?|对)[。！!.~\s]*$/i;
export const SEARCH_TOP_CLIP = 2000;
export const SEARCH_CLIP = 240;

const EMPTY_CORE_TEXT = '（没有常驻记忆）';
const EMPTY_RECALL_TEXT = '无。';
const RECALL_REMAINING_NOTE = (count: number) => `另有 ${count} 条已确认记忆未注入；需要时用 memory_read 的 search 查找。`;
const RECALL_INDEX_HEADER = '以下记忆未注入正文，只列标题；问题相关时用 memory_read 的 search 按标题查找后再读取：';

export type MemoryCandidateRow = {
  id: string;
  revision: number;
  kind: string;
  title: string;
  content: string;
  importance: number;
  labels: string[];
  updatedAt: string;
  status?: string;
  topicId?: string | null;
};

export type RankedMemory = { id: string; score: number; hits: number; exact: boolean };

export type MemoryContext = {
  coreText: string;
  recallText: string;
  stats: {
    candidates: number;
    coreIds: string[];
    recallIds: string[];
    indexIds: string[];
    coreChars: number;
    recallChars: number;
    skipped: 'trivial' | 'all-fit' | null;
  };
};

function clipPoints(text: string, max: number) {
  const points = [...text];
  if (points.length <= max) return text;
  return `${points.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** 简单回复（"好的""谢谢"）不触发检索；归一化后整句匹配。 */
export function isTrivialPrompt(userText: string) {
  return TRIVIAL_PATTERN.test(normalizeQuery(userText));
}

const SYMBOL_ONLY = /^[\p{P}\p{S}]+$/u;
const HAN_PAIR = /^\p{Script=Han}{2}$/u;

/** 同分排序：importance desc, updatedAt desc, id asc。 */
function tieOrder(left: { importance: number; updatedAt: string; id: string }, right: { importance: number; updatedAt: string; id: string }) {
  return (right.importance - left.importance)
    || (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/**
 * 相关度排序（5.4 的精确定义，2026-11-05 修订见第 11 节）。
 * 1. q = normalizeQuery(query) 截前 RECALL_QUERY_CHARS 个码点；
 * 2. 片段集合 Q：空格分段。长度 ≥3 的段取全部 3 字切片，并取其中两个字都是汉字的 2 字切片；
 *    长度 2 的段取自身。纯标点/符号片段丢弃，2 字片段去掉 STOP_BIGRAMS；
 * 3. 精确词：分段中长度 ≥2 的词；
 * 4. 字段权重：标题 3、标签拼接 2、正文 1（均在归一化文本上做子串判断）；
 * 5. idf(t) = ln(1 + (N - n_t + 0.5)/(n_t + 0.5))；
 * 6. f(t,d) = 含 t 的字段中的最大权重；2 字片段再乘 RECALL_BIGRAM_WEIGHT；
 * 7. score = Σ idf·f；
 * 8. hits 数 3 字片段，bigramHits 数 2 字片段，titleBigramHits 数标题里命中的 2 字片段；
 * 9. 通过 = 精确词命中标题或正文，或 hits ≥ RECALL_MIN_HITS，或 titleBigramHits ≥ 1，
 *    或 bigramHits ≥ RECALL_MIN_BIGRAM_HITS；
 * 10. 排序 score desc, importance desc, updatedAt desc, id asc。
 * 纯函数：不访问数据库。
 */
export function rankMemories(query: string, candidates: MemoryCandidateRow[]): RankedMemory[] {
  const q = [...normalizeQuery(query)].slice(0, RECALL_QUERY_CHARS).join('');
  const segments = q.split(' ').filter(Boolean);
  const fragments: string[] = [];
  const keep = (fragment: string) => !SYMBOL_ONLY.test(fragment);
  for (const segment of segments) {
    const units = [...segment];
    if (units.length >= 3) {
      for (let index = 0; index + 3 <= units.length; index += 1) {
        const fragment = units.slice(index, index + 3).join('');
        if (keep(fragment)) fragments.push(fragment);
      }
      for (let index = 0; index + 2 <= units.length; index += 1) {
        const fragment = units.slice(index, index + 2).join('');
        if (HAN_PAIR.test(fragment) && !STOP_BIGRAMS.has(fragment)) fragments.push(fragment);
      }
    } else if (units.length === 2 && keep(segment) && !STOP_BIGRAMS.has(segment)) {
      fragments.push(segment);
    }
  }
  const uniqueFragments = [...new Set(fragments)];
  const threeGrams = new Set(uniqueFragments.filter((fragment) => codePointLength(fragment) === 3));
  const exactWords = segments.filter((segment) => codePointLength(segment) >= 2 && !SYMBOL_ONLY.test(segment));
  if (!uniqueFragments.length && !exactWords.length) return [];

  const documents = candidates.map((row) => ({
    row,
    title: normalizeQuery(row.title),
    labels: normalizeQuery(row.labels.join(' ')),
    content: normalizeQuery(row.content),
  }));
  const total = documents.length;
  const idf = new Map<string, number>();
  for (const fragment of uniqueFragments) {
    let containing = 0;
    for (const document of documents) {
      if (document.title.includes(fragment) || document.labels.includes(fragment) || document.content.includes(fragment)) containing += 1;
    }
    idf.set(fragment, Math.log(1 + (total - containing + 0.5) / (containing + 0.5)));
  }

  const scored = documents.map((document) => {
    let score = 0;
    let hits = 0;
    let bigramHits = 0;
    let titleBigramHits = 0;
    for (const fragment of uniqueFragments) {
      const inTitle = document.title.includes(fragment);
      const inLabels = document.labels.includes(fragment);
      const inContent = document.content.includes(fragment);
      const weight = inTitle ? 3 : inLabels ? 2 : inContent ? 1 : 0;
      if (!weight) continue;
      const trigram = threeGrams.has(fragment);
      score += (idf.get(fragment) ?? 0) * weight * (trigram ? 1 : RECALL_BIGRAM_WEIGHT);
      if (trigram) hits += 1;
      else {
        bigramHits += 1;
        if (inTitle) titleBigramHits += 1;
      }
    }
    const exact = exactWords.some((word) => document.title.includes(word) || document.content.includes(word));
    const passed = exact || hits >= RECALL_MIN_HITS || titleBigramHits >= 1 || bigramHits >= RECALL_MIN_BIGRAM_HITS;
    return { id: document.row.id, score, hits, exact, passed, importance: document.row.importance, updatedAt: document.row.updatedAt };
  });

  return scored
    .filter((item) => item.passed)
    .sort((left, right) => (right.score - left.score) || tieOrder(left, right))
    .map(({ id, score, hits, exact }) => ({ id, score, hits, exact }));
}

/** 常驻记忆渲染：每条一行，装到 CORE_BUDGET 为止；放不下的条目由调用方转入召回候选。 */
export function renderCore(entries: MemoryCandidateRow[], budget = CORE_BUDGET): { text: string; includedIds: string[] } {
  if (!entries.length) return { text: EMPTY_CORE_TEXT, includedIds: [] };
  const lines: string[] = [];
  const includedIds: string[] = [];
  let used = 0;
  for (const entry of entries) {
    const line = `- id=${entry.id} r${entry.revision} ${entry.kind} 《${clipPoints(entry.title, CORE_TITLE_CLIP)}》 ${clipPoints(entry.content, CORE_CONTENT_CLIP)}`;
    const next = used + (lines.length ? 1 : 0) + codePointLength(line);
    if (next > budget) continue;
    lines.push(line);
    includedIds.push(entry.id);
    used = next;
  }
  return { text: lines.join('\n'), includedIds };
}

/** 相关记忆渲染：两行一条，装到 RECALL_BUDGET 为止，只返回装下的条目（不含剩余提示行，由调用方按候选池计数）。 */
export function renderRecall(entries: MemoryCandidateRow[], budget = RECALL_BUDGET): { text: string; includedIds: string[] } {
  const lines: string[] = [];
  const includedIds: string[] = [];
  let used = 0;
  for (const entry of entries) {
    const line = `- id=${entry.id} r${entry.revision} ${entry.kind} 《${clipPoints(entry.title, RECALL_TITLE_CLIP)}》\n  ${clipPoints(entry.content, RECALL_CONTENT_CLIP)}`;
    const next = used + (lines.length ? 1 : 0) + codePointLength(line);
    if (next > budget) continue;
    lines.push(line);
    includedIds.push(entry.id);
    used = next;
  }
  return { text: lines.join('\n'), includedIds };
}

/** memory_read search 的统一排序（5.6）：rankMemories 通过的在前，
 * 旧规则命中但排序器未通过的在后（组内 importance desc, updatedAt desc, id asc）。
 * q 为空时不排序，直接按候选顺序（调用方已按同序取数）。返回完整并集，条数截断由渲染处理。 */
export function orderMemorySearch(q: string, candidates: MemoryCandidateRow[], oldHits: MemoryCandidateRow[]): MemoryCandidateRow[] {
  if (!q.trim()) return candidates;
  const ranked = rankMemories(q, candidates);
  const rankedIds = new Set(ranked.map((item) => item.id));
  const byId = new Map(candidates.map((entry) => [entry.id, entry]));
  const rankedEntries = ranked.map((item) => byId.get(item.id)).filter((entry): entry is MemoryCandidateRow => Boolean(entry));
  const oldOnly = oldHits.filter((entry) => !rankedIds.has(entry.id)).sort(tieOrder);
  return [...rankedEntries, ...oldOnly];
}

/** search 结果渲染：最多 20 条，第 1 条正文最多 SEARCH_TOP_CLIP 字，其余 SEARCH_CLIP 字。 */
export function renderMemorySearchMatches(entries: MemoryCandidateRow[], options: { withTopicId?: boolean } = {}) {
  const matches = entries.slice(0, 20).map((entry, index) => ({
    id: entry.id,
    title: entry.title,
    revision: entry.revision,
    ...(options.withTopicId ? { topicId: entry.topicId ?? null } : {}),
    content: clipPoints(entry.content, index === 0 ? SEARCH_TOP_CLIP : SEARCH_CLIP),
    ...(entry.status ? { status: entry.status } : {}),
  }));
  return { matches, truncated: entries.length > matches.length };
}

/** 标题索引：未注入正文的记忆只列标题，装到 RECALL_INDEX_BUDGET 为止，让模型知道还有哪些记忆可读。 */
export function renderIndex(entries: MemoryCandidateRow[], budget = RECALL_INDEX_BUDGET): { text: string; includedIds: string[] } {
  const lines: string[] = [];
  const includedIds: string[] = [];
  let used = codePointLength(RECALL_INDEX_HEADER);
  for (const entry of entries) {
    const line = `- 《${clipPoints(entry.title, RECALL_INDEX_TITLE_CLIP)}》`;
    const next = used + 1 + codePointLength(line);
    if (next > budget) continue;
    lines.push(line);
    includedIds.push(entry.id);
    used = next;
  }
  return { text: lines.length ? [RECALL_INDEX_HEADER, ...lines].join('\n') : '', includedIds };
}

/** 读取并组装常驻记忆与相关记忆。范围与旧 formatMemoryReference 一致：收集箱始终在内，清单范围再加当前清单。 */
export async function buildMemoryContext(input: { topicId: string | null; identityId: string; userText: string }): Promise<MemoryContext> {
  const rows = await prisma.memory.findMany({
    where: {
      status: 'active',
      identityId: input.identityId,
      OR: [{ topicId: null }, ...(input.topicId ? [{ topicId: input.topicId }] : [])],
    },
    orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
    select: { id: true, revision: true, kind: true, title: true, content: true, importance: true, labels: true, updatedAt: true },
  });
  const candidates: MemoryCandidateRow[] = rows.map((row) => ({ ...row, labels: readLabels(row.labels) }));

  const core = renderCore(candidates.filter((entry) => entry.kind === 'constraint' || entry.importance >= 5));
  const coreIdSet = new Set(core.includedIds);
  const pool = candidates.filter((entry) => !coreIdSet.has(entry.id));

  if (isTrivialPrompt(input.userText)) {
    return {
      coreText: core.text,
      recallText: EMPTY_RECALL_TEXT,
      stats: { candidates: candidates.length, coreIds: core.includedIds, recallIds: [], indexIds: [], coreChars: codePointLength(core.text), recallChars: codePointLength(EMPTY_RECALL_TEXT), skipped: 'trivial' },
    };
  }

  // 全部放得下就全放：候选池整体渲染后仍在预算内时，跳过排序，按常驻排序规则全部注入。
  const rendered = renderRecall(pool);
  if (rendered.includedIds.length === pool.length) {
    const recallText = rendered.text || EMPTY_RECALL_TEXT;
    return {
      coreText: core.text,
      recallText,
      stats: { candidates: candidates.length, coreIds: core.includedIds, recallIds: rendered.includedIds, indexIds: [], coreChars: codePointLength(core.text), recallChars: codePointLength(recallText), skipped: 'all-fit' },
    };
  }

  const ranked = rankMemories(input.userText, pool);
  // 相对分数截断：得分低于首条 RECALL_MIN_SCORE_RATIO 倍的条目只进标题索引，避免高频词拖进无关正文。
  const floor = ranked.length ? ranked[0].score * RECALL_MIN_SCORE_RATIO : 0;
  const rankedById = new Map(candidates.map((entry) => [entry.id, entry]));
  const top = ranked.filter((item) => item.score >= floor).slice(0, RECALL_TOP_K).map((item) => rankedById.get(item.id)).filter((entry): entry is MemoryCandidateRow => Boolean(entry));
  const recall = renderRecall(top);
  const recalledIds = new Set(recall.includedIds);
  // 标题索引按常驻排序规则（候选已按 importance desc, updatedAt desc, id asc 取数）。
  const index = renderIndex(pool.filter((entry) => !recalledIds.has(entry.id)));
  const remaining = pool.length - recall.includedIds.length - index.includedIds.length;
  const parts = [recall.text, index.text, remaining > 0 ? RECALL_REMAINING_NOTE(remaining) : ''].filter(Boolean);
  const recallText = parts.length ? parts.join('\n') : EMPTY_RECALL_TEXT;
  return {
    coreText: core.text,
    recallText,
    stats: { candidates: candidates.length, coreIds: core.includedIds, recallIds: recall.includedIds, indexIds: index.includedIds, coreChars: codePointLength(core.text), recallChars: codePointLength(recallText), skipped: null },
  };
}
