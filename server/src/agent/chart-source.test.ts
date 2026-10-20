import { describe, it, expect } from 'vitest';
import { prisma } from '../infrastructure/prisma.js';
import { verifyChartSource } from './chart-source.js';
import { validateReplyBlock } from './content-blocks.js';

describe('chart provenance', () => {
  it('binds exact values and labels to successful results in this conversation', async () => {
    const conversation = await prisma.conversation.create({ data: {} });
    const other = await prisma.conversation.create({ data: {} });
    const source = await prisma.message.create({ data: { conversationId: conversation.id, role: 'tool', toolCallId: 'source-data', content: JSON.stringify({ success: true, data: { items: [{ title: '一', minutes: 10 }, { title: '二', minutes: 20 }] } }) } });
    try {
      const spec = { kind: 'bar' as const, title: '真实用时', categories: ['一', '二'], series: [{ name: '分钟', values: [10, 20] }], provenance: { kind: 'tool' as const, label: '任务工具结果', messageId: source.id, toolCallId: 'source-data', dataPath: ['items'], categoryField: 'title', valueFields: ['minutes'] } };
      await expect(verifyChartSource(conversation.id, spec)).resolves.toBeUndefined();
      await expect(validateReplyBlock({ type: 'chart', spec }, async () => [], (value) => verifyChartSource(conversation.id, value))).resolves.toHaveProperty('spec');
      await expect(verifyChartSource(other.id, spec)).rejects.toThrow('不属于');
      await expect(verifyChartSource(conversation.id, { ...spec, series: [{ name: '分钟', values: [10, 99] }] })).rejects.toThrow('不一致');
      await expect(verifyChartSource(conversation.id, { ...spec, provenance: { ...spec.provenance, dataPath: ['__proto__'] } })).rejects.toThrow('不存在');
    } finally { await prisma.conversation.deleteMany({ where: { id: { in: [conversation.id, other.id] } } }); }
  });
});
