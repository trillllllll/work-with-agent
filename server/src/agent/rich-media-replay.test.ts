import { withTestToolLoading } from './test-model-tools.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from '../test-auth.js';
import { app } from '../app.js';
import { prisma } from '../infrastructure/prisma.js';
import { AgentService } from '../agent.js';
import { ContextService } from '../application/conversation.js';
import { archiveCompletedTurns } from '../application/auto-memory-chat.js';

describe('rich reply downstream consumers', () => {
  it('keeps one readable projection for model replay, saved conversations, auto-memory archives and compaction', async () => {
    // This consumer scans all completed turns; isolate it from unrelated suites' archived/deleted topics.
    await prisma.autoMemoryTurn.deleteMany();
    const conversation = await prisma.conversation.create({ data: {} });
    const baseTime = Date.now();
    // Two early turns remain in the retained head; the rich reply must enter the summarized middle.
    await prisma.message.createMany({ data: Array.from({ length: 4 }, (_, index) => ({ conversationId: conversation.id, role: index % 2 ? 'assistant' : 'user', content: `早期对话${index}`, createdAt: new Date(baseTime - 10000 + index).toISOString() })) });
    const payload = { blocks: [
      { type: 'text', markdown: '正文投影唯一标记\n\n|分类|数量|\n|---|---|\n|已完成|2|' },
      { type: 'mermaid', title: '流程投影唯一标记', source: 'flowchart LR; 输入-->执行' },
      { type: 'chart', spec: { kind: 'bar', title: '图表投影唯一标记', categories: ['周一'], series: [{ name: '完成', values: [2] }], provenance: { kind: 'simulated', label: '验收模拟数据' } } },
    ] };
    const args = JSON.stringify(payload);
    const agent = new AgentService({ stream: withTestToolLoading(async function* () {
      for (let offset = 0; offset < args.length; offset += 13) yield { toolDelta: { index: 0, id: 'rich-replay', name: 'present_reply', argumentsDelta: args.slice(offset, offset + 13) } };
      yield { toolCalls: [{ id: 'rich-replay', name: 'present_reply', arguments: payload }] };
    }) } as never);
    const result = await agent.chat({ conversationId: conversation.id, message: '请展示流程和模拟图表', requestKey: randomUUID() });
    expect(result.events.some((event) => event.type === 'error')).toBe(false);
    const reply = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id, role: 'assistant', blocksJson: { not: null } } });
    expect(reply.status).toBe('completed'); expect(reply.toolCalls).toBeNull();
    const assertProjection = (text: string) => {
      for (const marker of ['正文投影唯一标记', '流程投影唯一标记', '图表投影唯一标记（验收模拟数据）']) expect(text.split(marker)).toHaveLength(2);
      expect(text).toContain('flowchart LR; 输入-->执行'); expect(text).toContain('simulated'); expect(text).toContain('验收模拟数据'); expect(text).toContain('|已完成|2|');
      expect(text).not.toContain('argumentsDelta');
    };
    assertProjection(reply.content);
    const context = await new ContextService().assemble(conversation.id);
    assertProjection(context.messages.filter((row) => row.role === 'assistant').map((row) => row.content).join('\n'));
    const saved = await request(app).post('/api/v1/knowledge/materials/from-conversation').send({ conversationId: conversation.id, title: '富媒体会话保存验收', messageIds: [reply.id] });
    expect(saved.status, saved.text).toBe(200); expect(saved.body.data.status).toBe('applied');
    const material = await prisma.material.findUniqueOrThrow({ where: { id: saved.body.data.results[0].id } });
    assertProjection((await prisma.materialVersion.findUniqueOrThrow({ where: { materialId_revision: { materialId: material.id, revision: material.revision } } })).content);
    await archiveCompletedTurns();
    const user = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id, role: 'user', content: '请展示流程和模拟图表' } });
    const turn = await prisma.autoMemoryTurn.findUniqueOrThrow({ where: { id: user.id } });
    expect(turn.status).toBe('completed');
    const excerptIds = JSON.parse(turn.materialIds) as string[]; expect(excerptIds.length).toBeGreaterThan(0);
    const excerpts = await prisma.materialVersion.findMany({ where: { materialId: { in: excerptIds }, revision: 1 }, orderBy: { materialId: 'asc' } });
    assertProjection(excerpts.map((item) => item.content).join('\n'));
    await prisma.message.createMany({ data: Array.from({ length: 18 }, (_, index) => ({ conversationId: conversation.id, role: index % 2 ? 'assistant' : 'user', content: `后续${index} ${'长文'.repeat(700)}`, createdAt: new Date(baseTime + 10000 + index).toISOString() })) });
    let summaryInput = '';
    const compacting = new ContextService({ complete: async (messages) => { summaryInput = String(messages[1].content); return { text: '已总结图文上下文' }; } });
    await compacting.compact(conversation.id);
    assertProjection(summaryInput);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: reply.id } })).compactedAt).toBeTruthy();
    const snapshot = await agent.snapshot(conversation.id);
    const restored = snapshot.messages.find((row) => row.id === reply.id)!;
    expect(restored.blocksJson).toBe(reply.blocksJson); expect(restored.content).toBe(reply.content);
  });
});
