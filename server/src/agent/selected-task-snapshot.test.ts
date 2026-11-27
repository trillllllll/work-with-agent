import { describe, expect, it } from 'vitest';
import { AgentService, type ModelMessage } from '../agent.js';
import { prisma } from '../infrastructure/prisma.js';
import { contextFromRequest, validateScopeAndResolveIds, type ChatContextV3 } from './chat-context.js';
import { executeBuiltinTool } from './builtin-tools.js';
import { messagesTokens, projectToolContent, SELECTED_TASK_SNAPSHOT_TOKEN_BUDGET, textTokens } from './context-budget.js';

const now = () => new Date().toISOString();
const context = (selectedTaskIds: string[] = []): ChatContextV3 => ({
  schemaVersion: 3, page: 'inbox', scope: { kind: 'inbox' }, taskId: null, materialId: null,
  selectedTaskIds, taskFilter: null, timeZone: 'Asia/Shanghai', referencedApprovalId: null,
  label: '收集箱', section: null, mode: 'follow', taskRevision: null, materialRevision: null,
  selectedMaterialIds: [], pageState: {}, attachments: [],
});
const execute = (args: Record<string, unknown>, selectedTaskIds: string[]) => executeBuiltinTool({
  name: 'query_tasks', args, context: contextFromRequest({ context: context(selectedTaskIds) }),
  run: { id: '', leaseToken: '', conversationId: '', assistantMessageId: '', sourceUserMessageId: '' }, toolCallId: '',
});
const projectedEnvelope = (messages: ModelMessage[], callId: string) => {
  const message = messages.find(row => row.role === 'tool' && row.tool_call_id === callId);
  expect(message).toBeTruthy();
  return JSON.parse(String(message!.content));
};

describe('selected task snapshot', () => {
  it('delivers all 12 selected tasks through the real final projection and reads one needed detail', async () => {
    const stamp = `${Date.now()}-${Math.random()}`;
    const special = '关键限制：只能在周五 18:00 前由值班同学处理。';
    const selected = await Promise.all(Array.from({ length: 12 }, async (_, index) => prisma.task.create({
      data: {
        id: `selected-${stamp}-${index}`,
        title: `整理样本 ${index + 1}`,
        description: index === 11 ? special : '',
        status: index % 3 === 0 ? 'doing' : 'todo',
        priority: index % 2 === 0 ? 'high' : 'medium',
        dueDate: `2026-12-${String(index + 1).padStart(2, '0')}`,
        revision: index + 1,
        createdAt: now(), updatedAt: now(),
      },
    })));
    const unrelated = await prisma.task.create({
      data: { id: `unrelated-${stamp}`, title: '未选中任务不得混入', description: '未选中正文', createdAt: now(), updatedAt: now() },
    });
    const selectedIds = selected.map(row => row.id);
    const requests: ModelMessage[][] = [];
    let round = 0;
    const agent = new AgentService({ stream: async function* (messages: ModelMessage[]) {
      requests.push(messages);
      if (round++ === 0) {
        yield { toolCalls: [{ id: 'selected-page', name: 'query_tasks', arguments: { action: 'selected' } }] };
        return;
      }
      if (round === 2) {
        const envelope = projectedEnvelope(messages, 'selected-page');
        expect(envelope.data.kind).toBe('selected-task-snapshot');
        expect(envelope.data.coverage).toMatchObject({ total: 12, readable: 12, returned: 12, covered: 12, remaining: 0, unavailable: 0 });
        expect(envelope.data.hasMore).toBe(false);
        expect(envelope.data.nextCursor).toBeNull();
        expect(envelope.data.items.map((row: { id: string }) => row.id)).toEqual(selectedIds);
        for (const [index, task] of selected.entries()) {
          expect(envelope.data.items[index]).toMatchObject({
            id: task.id, title: task.title, status: task.status, priority: task.priority,
            dueDate: task.dueDate, revision: task.revision,
          });
        }
        expect(envelope.data.items[11]).toMatchObject({ hasDescription: true });
        expect(JSON.stringify(envelope)).not.toContain(special);
        expect(JSON.stringify(envelope)).not.toContain(unrelated.id);
        expect(JSON.stringify(envelope)).not.toContain(unrelated.title);
        yield { toolCalls: [{ id: 'needed-detail', name: 'query_tasks', arguments: { action: 'get', taskId: selectedIds[11] } }] };
        return;
      }
      const detail = projectedEnvelope(messages, 'needed-detail');
      expect(detail.data.id).toBe(selectedIds[11]);
      expect(detail.data.description).toContain(special);
      yield { text: `补查后确认：${special}` };
    } } as never);

    const result = await agent.chat({ message: '整理选中的任务，不要修改', context: context(selectedIds) });
    expect(result.events.at(-1)?.type).toBe('done');
    expect(result.events.some(event => event.type === 'error')).toBe(false);
    expect(result.events.filter(event => event.type === 'tool_result' && event.toolName === 'query_tasks')).toHaveLength(2);
    expect(result.events.some(event => event.type === 'approval_required')).toBe(false);
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[1])).not.toContain(special);
    expect(JSON.stringify(requests[2])).toContain(special);
    const after = await prisma.task.findMany({ where: { id: { in: [...selectedIds, unrelated.id] } }, select: { id: true, revision: true } });
    expect(after.find(row => row.id === unrelated.id)?.revision).toBe(unrelated.revision);
    for (const task of selected) expect(after.find(row => row.id === task.id)?.revision).toBe(task.revision);

    const snapshotOnlyInput = requests.slice(0, 2).reduce((sum, messages) => sum + messagesTokens(messages), 0);
    const withDetailInput = requests.reduce((sum, messages) => sum + messagesTokens(messages), 0);
    console.info(`[selected-task-snapshot simulation] ${JSON.stringify({
      snapshotOnly: { taskQueries: 1, modelRequests: 2, cumulativeEstimatedInputTokens: snapshotOnlyInput },
      withOneDetail: { taskQueries: 2, modelRequests: 3, cumulativeEstimatedInputTokens: withDetailInput },
      estimator: 'mixed-text-v1',
    })}`);
  });

  it('pages 100 long Chinese and English titles within an explicit projection budget and stales cursors on revision changes', async () => {
    const stamp = `${Date.now()}-${Math.random()}`;
    const titles = Array.from({ length: 100 }, (_, index) => index % 2 === 0
      ? `长标题-${index}-` + '限制说明'.repeat(60)
      : `Long-title-${index}-` + 'constraint-'.repeat(40));
    await prisma.task.createMany({ data: titles.map((title, index) => ({
      id: `long-${stamp}-${index}`, title, createdAt: now(), updatedAt: now(),
    })) });
    const selectedIds = titles.map((_, index) => `long-${stamp}-${index}`);
    let cursor: string | undefined;
    const seen: string[] = [];
    let pages = 0;
    do {
      const result = await execute({ action: 'selected', limit: 100, ...(cursor ? { cursor } : {}) }, selectedIds);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.coverage).toMatchObject({
        total: 100, readable: 100, returned: data.items.length,
        covered: seen.length + data.items.length,
        remaining: 100 - seen.length - data.items.length,
        unavailable: 0,
      });
      expect(data.items.length).toBeGreaterThan(0);
      expect(data.items.length).toBeLessThanOrEqual(100);
      expect(data.hasMore).toBe(data.coverage.remaining > 0);
      for (const item of data.items) {
        expect(item.titleCharacters).toBeGreaterThan(120);
        expect(item.titleTruncated).toBe(true);
        expect([...item.title]).toHaveLength(120);
      }
      const original = JSON.stringify({ toolName: 'query_tasks', sourceMessageId: `page-${pages}`, ...result });
      const projected = projectToolContent(original);
      expect(textTokens(projected)).toBeLessThanOrEqual(SELECTED_TASK_SNAPSHOT_TOKEN_BUDGET);
      expect(JSON.parse(projected).data.items).toEqual(data.items);
      seen.push(...data.items.map((row: { id: string }) => row.id));
      cursor = data.nextCursor ?? undefined;
      pages++;
      expect(pages).toBeLessThanOrEqual(100);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(selectedIds);
    expect(new Set(seen).size).toBe(100);

    const first = await execute({ action: 'selected', limit: 1 }, selectedIds);
    const nextCursor = (first.data as any).nextCursor as string;
    expect(nextCursor).toBeTruthy();
    await prisma.task.update({ where: { id: selectedIds[0] }, data: { revision: { increment: 1 } } });
    const stale = await execute({ action: 'selected', limit: 1, cursor: nextCursor }, selectedIds);
    expect(stale).toMatchObject({ success: false, code: 'CURSOR_STALE' });
  });

  it('keeps empty, missing, deleted and out-of-scope selections explicit without broadening reads', async () => {
    const stamp = `${Date.now()}-${Math.random()}`;
    const valid = await prisma.task.create({ data: { id: `valid-${stamp}`, title: '有效选中', createdAt: now(), updatedAt: now() } });
    const deleted = await prisma.task.create({ data: { id: `deleted-${stamp}`, title: '已删除选中', deletedAt: now(), createdAt: now(), updatedAt: now() } });
    const unrelated = await prisma.task.create({ data: { id: `outside-${stamp}`, title: '范围外任务', createdAt: now(), updatedAt: now() } });
    const empty = await execute({ action: 'selected' }, []);
    expect(empty.data).toMatchObject({ items: [], coverage: { total: 0, readable: 0, returned: 0, covered: 0, remaining: 0, unavailable: 0 }, hasMore: false, nextCursor: null });

    const result = await execute({ action: 'selected' }, [valid.id, deleted.id, `missing-${stamp}`]);
    expect(result.success).toBe(true);
    expect((result.data as any).items.map((row: { id: string }) => row.id)).toEqual([valid.id]);
    expect((result.data as any).coverage).toMatchObject({ total: 3, readable: 1, returned: 1, covered: 1, remaining: 0, unavailable: 2 });
    expect(JSON.stringify(result.data)).not.toContain(unrelated.id);
    expect(JSON.stringify(result.data)).not.toContain(deleted.title);
    expect(await execute({ action: 'selected', scope: 'all', includeDeleted: true }, [valid.id])).toMatchObject({ success: false, code: 'INVALID_TOOL_ARGUMENTS' });
    await expect(validateScopeAndResolveIds(contextFromRequest({ context: context([valid.id, `missing-${stamp}`]) }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
