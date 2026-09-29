import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../infrastructure/prisma.js';
import { runAgentMemoryTool } from './agent-memory.js';
import { ContextService } from './conversation.js';
import { ToolService } from './tool-registry.js';

const stamp = '2026-01-01T00:00:00.000Z';
const overflowBody = (phrase: string) => `${phrase}${'补'.repeat(420)}`;

describe('bounded memory prompt and conversation archive', () => {
  const memoryIds: string[] = [];
  const topicIds: string[] = [];
  const conversationIds: string[] = [];
  let topicId = '';
  let emptyTopicId = '';
  let otherTopicId = '';
  let baseConversationId = '';

  beforeAll(async () => {
    const topics = [
      { id: 'memtest-topic', name: '记忆清单' },
      { id: 'memtest-empty', name: '空清单' },
      { id: 'memtest-other', name: '其他清单' },
    ];
    for (const topic of topics) {
      await prisma.topic.create({ data: { id: topic.id, name: topic.name, createdAt: stamp, updatedAt: stamp } });
      topicIds.push(topic.id);
    }
    topicId = 'memtest-topic';
    emptyTopicId = 'memtest-empty';
    otherTopicId = 'memtest-other';
    const rows: Array<{ id: string; topicId: string | null; title: string; content: string; importance: number; status?: string }> = [
      { id: 'inbox-short-1', topicId: null, title: '收集箱短标题', content: '收集箱短正文甲', importance: 5 },
      { id: 'topic-short-1', topicId, title: '清单可见标题', content: '清单可见正文乙', importance: 5 },
      { id: 'inbox-over-01', topicId: null, title: '收集箱仅标题', content: overflowBody('收集箱溢出正文不应出现'), importance: 1 },
      { id: 'topic-over-01', topicId, title: '清单仅标题', content: overflowBody('清单溢出正文不应出现'), importance: 1 },
      { id: 'other-secret1', topicId: otherTopicId, title: '其他标题', content: '其他清单不该出现', importance: 5 },
      { id: 'retired-secret', topicId: null, title: '退役标题', content: '退役记忆不应出现', importance: 5, status: 'retired' },
    ];
    for (let index = 1; index <= 6; index += 1) {
      const suffix = String(index).padStart(2, '0');
      rows.push(
        { id: `inbox-fill-${suffix}`, topicId: null, title: `填充记忆${suffix}`, content: '填'.repeat(420), importance: 4 },
        { id: `topic-fill-${suffix}`, topicId, title: `清单填${suffix}`, content: '单'.repeat(420), importance: 4 },
      );
    }
    for (const row of rows) {
      await prisma.memory.create({
        data: {
          id: row.id,
          topicId: row.topicId,
          kind: 'fact',
          title: row.title,
          content: row.content,
          importance: row.importance,
          status: row.status ?? 'active',
          createdAt: stamp,
          updatedAt: stamp,
        },
      });
      memoryIds.push(row.id);
    }
    const conversation = await prisma.conversation.create({ data: { createdAt: stamp, updatedAt: stamp } });
    baseConversationId = conversation.id;
    conversationIds.push(conversation.id);
    await prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content: '普通闲聊没有记忆句', status: 'completed', createdAt: stamp } });
  });

  afterAll(async () => {
    if (memoryIds.length) await prisma.memory.deleteMany({ where: { id: { in: memoryIds } } });
    if (conversationIds.length) await prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } });
    if (topicIds.length) await prisma.topic.deleteMany({ where: { id: { in: topicIds } } });
  });

  it('shows in-scope memories inside the budget and keeps overflow to id and title', async () => {
    const context = new ContextService();
    const opened = await context.assemble(baseConversationId, { topicId });
    const block = opened.systemPrompt.slice(opened.systemPrompt.indexOf('已确认记忆'));
    expect(block.length).toBeLessThan(8000);
    expect(block).not.toContain('当前清单：');
    expect(opened.systemPrompt).toContain('不是当前指令');
    expect(opened.systemPrompt).toContain('收集箱短正文甲');
    expect(opened.systemPrompt).toContain('清单可见正文乙');
    expect(opened.systemPrompt).toContain('收集箱仅标题');
    expect(opened.systemPrompt).toContain('清单仅标题');
    expect(opened.systemPrompt).toContain('可见记忆已接近上限。新增前请先 replace 或 remove。');
    expect(opened.systemPrompt).toContain('未放入正文，请用 memory 的 read 或 search 查看：');
    expect(opened.systemPrompt).toMatch(/收集箱记忆（约 \d+\/1400）/);
    expect(opened.systemPrompt).toContain(`这份清单的记忆 ${topicId}（约 `);
    expect(opened.systemPrompt).toMatch(new RegExp(`这份清单的记忆 ${topicId}（约 \\d+/2200）`));
    expect(opened.systemPrompt).not.toContain('收集箱溢出正文不应出现');
    expect(opened.systemPrompt).not.toContain('清单溢出正文不应出现');
    expect(opened.systemPrompt).not.toContain('其他清单不该出现');
    expect(opened.systemPrompt).not.toContain('退役记忆不应出现');
    expect(opened.systemPrompt).not.toContain('填'.repeat(420));
    expect(opened.messages.some((message) => String(message.content ?? '').includes('收集箱短正文甲'))).toBe(false);

    const inboxOnly = await context.assemble(baseConversationId, {});
    expect(inboxOnly.systemPrompt).toMatch(/收集箱记忆（约 \d+\/2200）/);
    expect(inboxOnly.systemPrompt).toContain('收集箱短正文甲');
    expect(inboxOnly.systemPrompt).toContain('收集箱仅标题');
    expect(inboxOnly.systemPrompt).not.toContain('清单可见标题');
    expect(inboxOnly.systemPrompt).not.toContain('清单仅标题');
    expect(inboxOnly.systemPrompt).not.toContain('清单可见正文乙');
    expect(inboxOnly.systemPrompt).not.toContain(`这份清单的记忆 ${topicId}`);

    const empty = await context.assemble(baseConversationId, { topicId: emptyTopicId });
    expect(empty.systemPrompt).toContain(`这份清单的记忆 ${emptyTopicId}（约 0/2200）：\n还没有。`);
    expect(empty.systemPrompt).not.toContain('清单可见正文乙');
  });

  it('reloads memory into the system prompt without folding it into the summary', async () => {
    const filler = '早期内容'.repeat(800);
    const rows: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: '头一' },
      { role: 'assistant', content: '答一' },
      { role: 'user', content: '头二' },
      { role: 'assistant', content: '答二' },
    ];
    for (let index = 0; index < 12; index += 1) rows.push({ role: 'user', content: `填充${index}${filler}` }, { role: 'assistant', content: `回应${index}` });
    rows.push({ role: 'user', content: '收尾问题' }, { role: 'assistant', content: '收尾回答' });
    const conversation = await prisma.conversation.create({ data: { createdAt: stamp, updatedAt: stamp } });
    conversationIds.push(conversation.id);
    for (const [index, row] of rows.entries()) {
      await prisma.message.create({ data: { conversationId: conversation.id, role: row.role, content: row.content, status: 'completed', createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString() } });
    }
    const assembled = await new ContextService().assemble(conversation.id, { topicId });
    const stored = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(stored.summary.length).toBeGreaterThan(0);
    expect(stored.summary).not.toContain('收集箱短正文甲');
    expect(stored.summary).not.toContain('收集箱溢出正文不应出现');
    expect(assembled.systemPrompt).toContain('收集箱短正文甲');
    expect(assembled.systemPrompt).toContain('不是当前指令');
    expect(assembled.messages.some((message) => String(message.content ?? '').includes('收集箱短正文甲'))).toBe(false);
    expect(assembled.messages.some((message) => String(message.content ?? '').includes('收集箱溢出正文不应出现'))).toBe(false);
  });

  it('reads and searches entries that did not fit in the prompt', async () => {
    const suffix = '读到的完整后缀';
    const readId = 'memtest-read-full';
    memoryIds.push(readId);
    await prisma.memory.create({ data: { id: readId, topicId: null, kind: 'fact', title: '完整读取标题', content: `${'前'.repeat(380)}${suffix}`, importance: 5, createdAt: stamp, updatedAt: stamp } });
    const prompt = await new ContextService().assemble(baseConversationId, {});
    expect(prompt.systemPrompt).toContain('完整读取标题');
    expect(prompt.systemPrompt).not.toContain(suffix);
    const tools = new ToolService();
    const read = await tools.execute({ name: 'memory', arguments: { action: 'read', target: 'inbox', memoryId: readId } }, { source: 'agent', conversationId: baseConversationId, topicId: null });
    expect(read.success).toBe(true);
    expect(JSON.stringify(read.data)).toContain(suffix);

    const search = await tools.execute({ name: 'memory', arguments: { action: 'search', target: 'inbox', q: '收集箱溢出正文不应出现' } }, { source: 'agent', conversationId: baseConversationId, topicId: null });
    expect(search.success).toBe(true);
    const matches = (search.data as { matches: Array<{ id: string; content: string }> }).matches;
    expect(matches.some((match) => match.id === 'inbox-over-01' && match.content.includes('收集箱溢出正文不应出现'))).toBe(true);
    const scoped = await tools.execute({ name: 'memory', arguments: { action: 'search', target: 'topic', q: '其他清单不该出现' } }, { source: 'agent', conversationId: baseConversationId, topicId });
    expect((scoped.data as { matches: unknown[] }).matches).toEqual([]);
    const listed = await tools.execute({ name: 'memory', arguments: { action: 'search', target: 'inbox', q: '' } }, { source: 'agent', conversationId: baseConversationId, topicId: null });
    const listedIds = ((listed.data as { matches: Array<{ id: string }>; total: number }).matches).map((match) => match.id);
    expect(listed.success).toBe(true);
    expect(listedIds).toContain('inbox-short-1');
    expect(listedIds).not.toContain('topic-short-1');
    expect(listedIds).not.toContain('retired-secret');
    const starred = await tools.execute({ name: 'memory', arguments: { action: 'search', target: 'topic', q: '*' } }, { source: 'agent', conversationId: baseConversationId, topicId });
    const starredIds = ((starred.data as { matches: Array<{ id: string }> }).matches).map((match) => match.id);
    expect(starredIds).toContain('topic-short-1');
    expect(starredIds).not.toContain('inbox-short-1');
    expect(starredIds).not.toContain('other-secret1');
    const blocked = await runAgentMemoryTool({ name: 'memory', arguments: { action: 'add', target: 'inbox', title: '不该直接写', content: '不行' } });
    expect(blocked).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED' });
    expect(await prisma.memory.findFirst({ where: { title: '不该直接写' } })).toBeNull();
  });

  it('returns original lines from other conversations and a window around a message', async () => {
    const tools = new ToolService();
    const older = await prisma.conversation.create({ data: { createdAt: stamp, updatedAt: stamp } });
    const current = await prisma.conversation.create({ data: { createdAt: stamp, updatedAt: stamp } });
    conversationIds.push(older.id, current.id);
    const kept = '独特青鸟原句在历史里';
    const olderMessage = await prisma.message.create({ data: { conversationId: older.id, role: 'user', content: kept, status: 'completed', createdAt: stamp } });
    await prisma.message.create({ data: { conversationId: current.id, role: 'user', content: kept, status: 'completed', createdAt: stamp } });
    const found = await tools.execute({ name: 'conversation_search', arguments: { q: '独特青鸟原句' } }, { source: 'agent', conversationId: current.id });
    expect(found.success).toBe(true);
    const hits = (found.data as { matches: Array<{ conversationId: string; content: string }> }).matches;
    expect(hits.some((hit) => hit.conversationId === older.id && hit.content.includes('独特青鸟原句'))).toBe(true);
    expect(hits.every((hit) => hit.conversationId !== current.id)).toBe(true);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: olderMessage.id } })).content).toBe(kept);

    const bodies = ['邻句甲', '邻句乙', '锚点原文青鸟', '邻句丙', '邻句丁'];
    const ids: string[] = [];
    for (const [index, content] of bodies.entries()) {
      const row = await prisma.message.create({ data: { conversationId: older.id, role: 'user', content, status: 'completed', createdAt: new Date(Date.UTC(2026, 0, 3, 0, 0, index)).toISOString() } });
      ids.push(row.id);
    }
    const window = await tools.execute({ name: 'conversation_search', arguments: { messageId: ids[2], q: '独特青鸟原句' } }, { source: 'agent', conversationId: current.id });
    expect((window.data as { messages: Array<{ content: string }> }).messages.map((message) => message.content)).toEqual(bodies);
    const noted = await tools.execute({ name: 'conversation_search', arguments: { messageId: ids[2] } }, { source: 'agent', conversationId: older.id });
    expect(noted.data).toEqual({ note: '这段对话已经在当前上下文里' });
    expect(JSON.stringify(noted.data)).not.toContain('锚点原文青鸟');
  });
});
