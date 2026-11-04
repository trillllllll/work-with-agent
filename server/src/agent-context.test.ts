import { withTestToolLoading } from './agent/test-model-tools.js';
import { describe, expect, it } from 'vitest';
import request from './test-auth.js';
import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import { AgentService, type ModelMessage } from './agent.js';
import { KnowledgeService } from './application/knowledge.js';
import { ownerActor } from './application/security.js';

const api = request(app);

describe('builtin run context', () => {
  it('keeps fixed notes, the brief, and nearby tasks separate, and asks before guessing “这些任务”', async () => {
    const topic = await api.post('/api/topics').send({ name: `上下文-${Date.now()}` });
    expect(topic.status, JSON.stringify(topic.body)).toBe(200);
    const topicId = topic.body.data.id as string;
    const knowledge = new KnowledgeService();
    await knowledge.brief(ownerActor, topicId);
    const stored = await prisma.workingBrief.findUniqueOrThrow({ where: { id: `topic:${topicId}` } });
    await knowledge.saveBrief(ownerActor, { topicId, expectedVersion: stored.revision, manualNotes: '固定约定：标题原样保留' });
    const titles = Array.from({ length: 10 }, (_, index) => `附近样本 ${index} ${Date.now()}`);
    for (const title of titles) {
      const created = await api.post('/api/tasks').send({ topicId, title });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
    }
    const selected = await api.post('/api/tasks').send({ topicId, title: '选中前的标题' });
    const renamed = await api.patch(`/api/tasks/${selected.body.data.id}`).send({ title: '服务端重新读取的标题' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    let seen = '';
    const agent = new AgentService({
      stream: withTestToolLoading(async function* (messages: ModelMessage[]) {
        seen = String(messages[0]?.content ?? '');
        yield { text: '先确认范围。' };
      }),
    } as never);
    await agent.chat({ message: '这些任务怎么处理', pageContext: { page: 'board', topicId, taskId: selected.body.data.id } });
    const notes = seen.split('【固定说明】')[1]?.split('【常驻记忆】')[0] ?? '';
    const brief = seen.split('【当前简报】')[1]?.split('【页面筛选与选中任务】')[0] ?? '';
    const nearby = seen.split('【附近任务】')[1]?.split('【本请求待确认方案】')[0] ?? '';
    expect(notes).toContain('固定约定：标题原样保留');
    expect(brief).not.toContain('固定约定：标题原样保留');
    expect(brief).toContain('## 资料摘录');
    expect(brief).not.toContain('## 资料与记忆摘录');
    expect(brief).not.toMatch(/^- memory /m);
    expect(seen).toContain('服务端重新读取的标题');
    expect(seen).toContain('先问清楚指哪些任务，不要默认取附近任务');
    expect(seen).toContain('get_time');
    expect(seen).toContain('【规划时间段】');
    expect(seen).not.toContain('execute_shell');
    expect(nearby.split('\n').filter((line) => line.startsWith('- ')).length).toBeLessThanOrEqual(8);
    const topicName = String(topic.body.data.name);
    expect(seen).toContain(`当前清单：${topicName} ${topicId}`);
    expect(seen.split('【选中对象】')[1]?.split('【附近任务】')[0] ?? '').toContain(`清单 ${topicName} ${topicId}`);
    expect(nearby).toContain(`清单 ${topicName} ${topicId}`);
    // 分层顺序锁定（docs/2026-11-04_memory-recall-plan.md 5.1）：慢变层先于易变层。
    // 只统计行首段头：应用功能知识手册正文会引用【规划时间段】等名称，不算段落本身。
    const headers = [...seen.matchAll(/^【([^】]+)】/gm)].map((match) => match[1]);
    const layered = ['固定说明', '常驻记忆', '规划时间段', '当前简报', '页面筛选与选中任务', '本次请求的上下文', '选中对象', '相关记忆', '附近任务', '本请求待确认方案'];
    const positions = layered.map((header) => headers.indexOf(header));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions.every((position, index) => index === 0 || position > positions[index - 1])).toBe(true);
    expect(headers.indexOf('固定说明')).toBeGreaterThan(headers.indexOf('应用功能知识 v0.6.0'));
  });

  it('labels selected and nearby tasks with their topic, falling back to 收集箱', async () => {
    const loose = (await api.post('/api/tasks').send({ title: '无清单上下文样本' })).body.data;
    let seen = '';
    const agent = new AgentService({
      stream: withTestToolLoading(async function* (messages: ModelMessage[]) {
        seen = String(messages[0]?.content ?? '');
        yield { text: '知道了。' };
      }),
    } as never);
    await agent.chat({ message: '这个任务在哪', pageContext: { page: 'inbox', taskId: loose.id } });
    expect(seen).toContain('当前清单：收集箱');
    expect(seen.split('【选中对象】')[1]?.split('【附近任务】')[0] ?? '').toContain('清单 收集箱');
  });
});
