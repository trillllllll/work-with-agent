import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 记忆召回核心测试（docs/2026-11-04_memory-recall-plan.md 5.2–5.4）。
 * 独立 scratch 库：候选集完全受控，all-fit 与预算截断的断言不依赖其他套件的数据。
 */

let scratch = '';
let recall: typeof import('./memory-recall.js');
let prisma: typeof import('../infrastructure/prisma.js')['prisma'];
let previousDatabaseUrl: string | undefined;
let previousDataDir: string | undefined;

const stamp = '2026-11-04T00:00:00.000Z';

type Row = { id: string; topicId: string | null; kind: string; title: string; content: string; importance: number; identityId?: string };
const baseRows: Row[] = [
  { id: 'rc-core-constraint', topicId: 'recall-topic', kind: 'constraint', title: '受控约束标题', content: '约束正文：任何修改只走确认。', importance: 3 },
  { id: 'rc-core-five', topicId: null, kind: 'fact', title: '五星标题', content: '五星正文内容', importance: 5 },
  { id: 'rc-gram', topicId: null, kind: 'fact', title: '数据库备份窗口', content: '每天凌晨两点执行一次全量备份任务', importance: 3 },
  { id: 'rc-exact', topicId: null, kind: 'fact', title: '值班安排', content: '周一到周五轮流值班', importance: 3 },
  { id: 'rc-study', topicId: null, kind: 'fact', title: '数据库备份窗口', content: '学习身份专属记忆', importance: 3, identityId: 'study' },
  { id: 'rc-other', topicId: 'recall-other', kind: 'fact', title: '数据库备份窗口', content: '别的清单的内容', importance: 3 },
  { id: 'rc-fit-a', topicId: 'recall-fit-topic', kind: 'fact', title: '适配甲', content: '短正文甲', importance: 3 },
  { id: 'rc-fit-b', topicId: 'recall-fit-topic', kind: 'fact', title: '适配乙', content: '短正文乙', importance: 3 },
];

async function createMemory(row: Row) {
  await prisma.memory.create({
    data: {
      id: row.id, topicId: row.topicId, kind: row.kind, title: row.title, content: row.content,
      importance: row.importance, identityId: row.identityId ?? 'work', status: 'active',
      createdAt: stamp, updatedAt: stamp,
    },
  });
}

beforeAll(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  previousDataDir = process.env.DOVUN_DATA_DIR;
  scratch = mkdtempSync(join(tmpdir(), 'wwa-memory-recall-'));
  process.env.DATABASE_URL = `file:${join(scratch, 'test.db')}`;
  process.env.DOVUN_DATA_DIR = join(scratch, 'data');
  const { migrateDatabase } = await import('../db-migrate.js');
  await migrateDatabase(process.env.DATABASE_URL);
  recall = await import('./memory-recall.js');
  prisma = (await import('../infrastructure/prisma.js')).prisma;
  for (const topicId of ['recall-topic', 'recall-other', 'recall-fit-topic']) {
    await prisma.topic.create({ data: { id: topicId, name: `召回-${topicId}`, createdAt: stamp, updatedAt: stamp } });
  }
  for (const row of baseRows) await createMemory(row);
}, 180_000);

afterAll(async () => {
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousDataDir === undefined) delete process.env.DOVUN_DATA_DIR;
  else process.env.DOVUN_DATA_DIR = previousDataDir;
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
});

describe('rankMemories', () => {
  const rows = () => baseRows.filter((row) => row.id !== 'rc-study').map((row) => ({ id: row.id, revision: 1, kind: row.kind, title: row.title, content: row.content, importance: row.importance, labels: [], updatedAt: stamp }));

  it('matches Chinese text through 3-char slices without any exact word', () => {
    const ranked = recall.rankMemories('数据库备份窗口在几点', rows());
    expect(ranked.map((item) => item.id)).toContain('rc-gram');
    const gram = ranked.find((item) => item.id === 'rc-gram')!;
    expect(gram.hits).toBeGreaterThanOrEqual(recall.RECALL_MIN_HITS);
    expect(gram.exact).toBe(false);
    expect(ranked.map((item) => item.id)).not.toContain('rc-exact');
  });

  it('matches 2-char exact words', () => {
    const ranked = recall.rankMemories('值班 计划', rows());
    expect(ranked.map((item) => item.id)).toEqual(['rc-exact']);
    expect(ranked[0].exact).toBe(true);
    expect(ranked[0].hits).toBe(0);
  });

  it('drops punctuation-only segments and returns nothing for symbol-only queries', () => {
    const ranked = recall.rankMemories('！！！。 数据库备份窗口', rows());
    expect(ranked.map((item) => item.id)).toContain('rc-gram');
    expect(recall.rankMemories('！！！。', rows())).toEqual([]);
  });

  it('labels short replies as trivial', () => {
    for (const text of ['好的。', '嗯嗯', 'ok', '谢谢！', '收到', 'ok~']) expect(recall.isTrivialPrompt(text)).toBe(true);
    for (const text of ['帮我查一下任务', '可以开始吗', '数据库备份窗口']) expect(recall.isTrivialPrompt(text)).toBe(false);
  });

  it('passes on a 2-char Han word in the title and ignores stop bigrams', () => {
    const candidates = [
      { id: 'b-work', revision: 1, kind: 'fact', title: '上班时间', content: '用户的上班时间为 10:00。', importance: 3, labels: [], updatedAt: stamp },
      { id: 'b-noise', revision: 1, kind: 'fact', title: '什么都能问', content: '这个那个都可以', importance: 3, labels: [], updatedAt: stamp },
    ];
    expect(recall.rankMemories('我几点上班', candidates).map((item) => item.id)).toEqual(['b-work']);
    expect(recall.rankMemories('这个是什么', candidates).map((item) => item.id)).toEqual([]);
  });

  it('does not build 2-char fragments from Latin text', () => {
    const candidates = [{ id: 'b-latin', revision: 1, kind: 'fact', title: 'about upgrades', content: 'bundle notes', importance: 3, labels: [], updatedAt: stamp }];
    expect(recall.rankMemories('bug report', candidates)).toEqual([]);
  });

  it('breaks score ties by importance, then newer updatedAt, then id', () => {
    const same = { revision: 1, kind: 'fact', title: '值班安排', content: '值班', labels: [] as string[] };
    const ranked = recall.rankMemories('值班', [
      { ...same, id: 't-old', importance: 3, updatedAt: '2026-01-01T00:00:00.000Z' },
      { ...same, id: 't-new', importance: 3, updatedAt: '2026-06-01T00:00:00.000Z' },
      { ...same, id: 't-high', importance: 4, updatedAt: '2025-01-01T00:00:00.000Z' },
    ]);
    expect(ranked.map((item) => item.id)).toEqual(['t-high', 't-new', 't-old']);
  });
});

describe('buildMemoryContext', () => {
  it('injects everything when the whole pool fits (all-fit)', async () => {
    const context = await recall.buildMemoryContext({ topicId: 'recall-fit-topic', identityId: 'work', userText: '随便问问看' });
    expect(context.stats.skipped).toBe('all-fit');
    expect(context.stats.coreIds).toEqual(['rc-core-five']);
    expect([...context.stats.recallIds].sort()).toEqual(['rc-exact', 'rc-fit-a', 'rc-fit-b', 'rc-gram'].sort());
    expect(context.recallText).not.toContain('另有');
  });

  it('skips retrieval for trivial replies but keeps core memories', async () => {
    const context = await recall.buildMemoryContext({ topicId: 'recall-topic', identityId: 'work', userText: '好的。' });
    expect(context.stats.skipped).toBe('trivial');
    expect(context.stats.recallIds).toEqual([]);
    expect(context.recallText).toBe('无。');
    expect(context.stats.coreIds).toContain('rc-core-constraint');
  });

  it('keeps core entries out of recall and renders them in coreText', async () => {
    const context = await recall.buildMemoryContext({ topicId: 'recall-topic', identityId: 'work', userText: '受控约束标题是什么' });
    expect(context.stats.coreIds).toEqual(expect.arrayContaining(['rc-core-constraint', 'rc-core-five']));
    expect(context.stats.recallIds).not.toContain('rc-core-constraint');
    expect(context.stats.recallIds).not.toContain('rc-core-five');
    expect(context.coreText).toContain('rc-core-constraint');
    expect(context.coreText).toContain('constraint');
  });

  it('isolates identities and topics', async () => {
    const context = await recall.buildMemoryContext({ topicId: 'recall-topic', identityId: 'work', userText: '数据库备份窗口在几点' });
    expect(context.stats.recallIds).toContain('rc-gram');
    expect(context.stats.recallIds).not.toContain('rc-study');
    expect(context.stats.recallIds).not.toContain('rc-other');
    const allIds = [...context.stats.coreIds, ...context.stats.recallIds];
    expect(allIds).not.toContain('rc-study');
    expect(allIds).not.toContain('rc-other');
  });

  it('caps recall at the budget and lists the rest as a title index', async () => {
    for (let index = 1; index <= 6; index += 1) {
      const suffix = String(index).padStart(2, '0');
      await createMemory({ id: `rc-bulk-${suffix}`, topicId: null, kind: 'fact', title: `批量标题${suffix}`, content: `批量正文${'长'.repeat(300)}`, importance: 2 });
    }
    const context = await recall.buildMemoryContext({ topicId: null, identityId: 'work', userText: '批量正文' });
    expect(context.stats.skipped).toBeNull();
    expect(context.stats.recallIds.length).toBeLessThanOrEqual(recall.RECALL_TOP_K);
    expect(context.stats.recallIds.every((id) => id.startsWith('rc-bulk-'))).toBe(true);
    const [entryPart, indexPart = ''] = context.recallText.split('\n以下记忆未注入正文');
    expect([...entryPart].length).toBeLessThanOrEqual(recall.RECALL_BUDGET);
    expect(context.stats.indexIds.length).toBeGreaterThan(0);
    expect(context.stats.indexIds.some((id) => context.stats.recallIds.includes(id))).toBe(false);
    expect([...`以下记忆未注入正文${indexPart}`].length).toBeLessThanOrEqual(recall.RECALL_INDEX_BUDGET);
    expect(indexPart).toContain('《值班安排》');
  });

  it('recalls a 2-char Chinese word inside an unspaced question', async () => {
    const context = await recall.buildMemoryContext({ topicId: null, identityId: 'work', userText: '今天谁来值班啊' });
    expect(context.stats.recallIds).toContain('rc-exact');
  });

  it('renders identical coreText for unchanged memories', async () => {
    const first = await recall.buildMemoryContext({ topicId: 'recall-topic', identityId: 'work', userText: '第一次' });
    const second = await recall.buildMemoryContext({ topicId: 'recall-topic', identityId: 'work', userText: '完全不同的问题' });
    expect(second.coreText).toBe(first.coreText);
  });

  it('writes the empty placeholder when no core entries qualify', async () => {
    await prisma.memory.update({ where: { id: 'rc-core-constraint' }, data: { status: 'retired' } });
    await prisma.memory.update({ where: { id: 'rc-core-five' }, data: { status: 'retired' } });
    try {
      const context = await recall.buildMemoryContext({ topicId: 'recall-fit-topic', identityId: 'work', userText: '适配甲是什么' });
      expect(context.coreText).toBe('（没有常驻记忆）');
      expect(context.stats.coreIds).toEqual([]);
    } finally {
      await prisma.memory.update({ where: { id: 'rc-core-constraint' }, data: { status: 'active' } });
      await prisma.memory.update({ where: { id: 'rc-core-five' }, data: { status: 'active' } });
    }
  });
});
