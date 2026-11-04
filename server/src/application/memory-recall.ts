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
export const TRIVIAL_PATTERN = /^(好的?|嗯+|ok|okay|谢谢|多谢|thanks?|thx|收到|可以|行|是的?|对)[。！!.~\s]*$/i;
export const SEARCH_TOP_CLIP = 2000;
export const SEARCH_CLIP = 240;

const EMPTY_CORE_TEXT = '（没有常驻记忆）';
const EMPTY_RECALL_TEXT = '无。';
const RECALL_REMAINING_NOTE = (count: number) => `另有 ${count} 条已确认记忆未注入；需要时用 memory_read 的 search 查找。`;

export type MemoryCandidateRow = {
  id: string;
  revision: number;
  kind: string;
  title: string;
  content: string;
  importance: number;
  labels: string[];
  updatedAt: string;
};

export type RankedMemory = { id: string; score: number; hits: number; exact: boolean };

export type MemoryContext = {
  coreText: string;
  recallText: string;
  stats: {
    candidates: number;
    coreIds: string[];
    recallIds: string[];
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

/**
 * 相关度排序（5.4 的精确定义）。
 * 1. q = normalizeQuery(query) 截前 RECALL_QUERY_CHARS 个码点；
 * 2. 片段集合 Q：空格分段，长度 ≥3 取全部 3 字切片，长度 2 取自身；纯标点/符号段丢弃；
 * 3. 精确词：分段中长度 ≥2 的词；
 * 4. 字段权重：标题 3、标签拼接 2、正文 1（均在归一化文本上做子串判断）；
 * 5. idf(t) = ln(1 + (N - n_t + 0.5)/(n_t + 0.5))；
 * 6. f(t,d) = 含 t 的字段中的最大权重；
 * 7. score = Σ idf·f；8. hits 只数 3 字片段；9. 通过 = 精确词命中标题或正文，或 hits ≥ RECALL_MIN_HITS；
 * 10. 排序 score desc, importance desc, updatedAt desc, id asc。
 * 纯函数：不访问数据库。
 */
export function rankMemories(query: string, candidates: MemoryCandidateRow[]): RankedMemory[] {
  const q = [...normalizeQuery(query)].slice(0, RECALL_QUERY_CHARS).join('');
  const segments = q.split(' ').filter(Boolean);
  const fragments: string[] = [];
  for (const segment of segments) {
    if (SYMBOL_ONLY.test(segment)) continue;
    const units = [...segment];
    if (units.length >= 3) {
      for (let index = 0; index + 3 <= units.length; index += 1) fragments.push(units.slice(index, index + 3).join(''));
    } else if (units.length === 2) {
      fragments.push(segment);
    }
  }
  const uniqueFragments = [...new Set(fragments)];
  const threeGrams = new Set(uniqueFragments.filter((fragment) => codePointLength(fragment) === 3));
  const exactWords = segments.filter((segment) => codePointLength(segment) >= 2);
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
    for (const fragment of uniqueFragments) {
      const inTitle = document.title.includes(fragment);
      const inLabels = document.labels.includes(fragment);
      const inContent = document.content.includes(fragment);
      const weight = inTitle ? 3 : inLabels ? 2 : inContent ? 1 : 0;
      if (weight > 0) score += (idf.get(fragment) ?? 0) * weight;
      if (weight > 0 && threeGrams.has(fragment)) hits += 1;
    }
    const exact = exactWords.some((word) => document.title.includes(word) || document.content.includes(word));
    return { id: document.row.id, score, hits, exact, importance: document.row.importance, updatedAt: document.row.updatedAt };
  });

  return scored
    .filter((item) => item.exact || item.hits >= RECALL_MIN_HITS)
    .sort((left, right) => (right.score - left.score)
      || (right.importance - left.importance)
      || (left.updatedAt < right.updatedAt ? -1 : left.updatedAt > right.updatedAt ? 1 : 0)
      || (left.id < right.id ? -1 : 1))
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
      stats: { candidates: candidates.length, coreIds: core.includedIds, recallIds: [], coreChars: codePointLength(core.text), recallChars: codePointLength(EMPTY_RECALL_TEXT), skipped: 'trivial' },
    };
  }

  // 全部放得下就全放：候选池整体渲染后仍在预算内时，跳过排序，按常驻排序规则全部注入。
  const rendered = renderRecall(pool);
  if (rendered.includedIds.length === pool.length) {
    const recallText = rendered.text || EMPTY_RECALL_TEXT;
    return {
      coreText: core.text,
      recallText,
      stats: { candidates: candidates.length, coreIds: core.includedIds, recallIds: rendered.includedIds, coreChars: codePointLength(core.text), recallChars: codePointLength(recallText), skipped: 'all-fit' },
    };
  }

  const ranked = rankMemories(input.userText, pool);
  const rankedById = new Map(candidates.map((entry) => [entry.id, entry]));
  const top = ranked.slice(0, RECALL_TOP_K).map((item) => rankedById.get(item.id)).filter((entry): entry is MemoryCandidateRow => Boolean(entry));
  const recall = renderRecall(top);
  const remaining = pool.length - recall.includedIds.length;
  const recallText = recall.text
    ? (remaining > 0 ? `${recall.text}\n${RECALL_REMAINING_NOTE(remaining)}` : recall.text)
    : (remaining > 0 ? RECALL_REMAINING_NOTE(remaining) : EMPTY_RECALL_TEXT);
  return {
    coreText: core.text,
    recallText,
    stats: { candidates: candidates.length, coreIds: core.includedIds, recallIds: recall.includedIds, coreChars: codePointLength(core.text), recallChars: codePointLength(recallText), skipped: null },
  };
}
