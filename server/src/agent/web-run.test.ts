import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../infrastructure/prisma.js';
import { resumeRun, resetRunSchedulerState, type ModelStream } from './runs.js';
import { ContextService } from '../application/conversation.js';

const ids: string[] = [];
async function seeded(policy: boolean, businessAttempted = false, writeIntent = false) {
  const timestamp = new Date().toISOString();
  const conversation = await prisma.conversation.create({ data: { identityId: 'study', createdAt: timestamp, updatedAt: timestamp } });
  ids.push(conversation.id);
  const message = await prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content: '搜一下 Go 官方文档', createdAt: timestamp } });
  const context = { schemaVersion: 2, identityId: 'study', page: 'learning', scope: { kind: 'inbox' }, taskId: null, materialId: null, selectedTaskIds: [], taskFilter: null, timeZone: 'Asia/Shanghai', timeZoneSource: 'default', referencedApprovalId: null };
  const cursor = { schemaVersion: 1, phase: 'model', round: 15, budgetEndRound: 16, assistantMessageId: null, nextToolIndex: 0, toolGroups: ['learning', 'web', ...(writeIntent ? ['learning_write'] : [])], ...(policy ? { webPolicy: 2, webUsed: true, businessAttempted } : {}) };
  return prisma.agentRun.create({ data: { conversationId: conversation.id, sourceUserMessageId: message.id, requestKey: randomUUID(), requestHash: 'test', state: 'paused', pauseReason: 'interrupted', contextJson: JSON.stringify(context), modelMessagesJson: JSON.stringify([{ role: 'system', content: '研究助手' }, { role: 'user', content: message.content }]), cursorJson: JSON.stringify(cursor), createdAt: timestamp, updatedAt: timestamp } });
}
async function runUntilSettled(id: string, stream: ModelStream) {
  await resumeRun(id, stream, new ContextService());
  for (let i = 0; i < 150; i++) {
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id } });
    if (!['queued', 'running'].includes(run.state)) return run;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Run did not settle');
}
afterEach(async () => {
  resetRunSchedulerState();
  await prisma.conversation.deleteMany({ where: { id: { in: ids.splice(0) } } });
});
describe('web research final round compatibility', () => {
  it('reserves the last round for an answer and refuses more research calls', async () => {
    const run = await seeded(true);
    const result = await runUntilSettled(run.id, async function* (messages, _signal, _includeTools, tools) {
      expect(tools!.every(tool => tool.function.name === 'present_reply')).toBe(true);
      expect(JSON.stringify(messages)).toContain('最后作答轮');
      yield { text: '已核实 Go 官方文档中的定义；其余部分尚未核实。' };
      yield { toolCalls: [{ id: 'ignored', name: 'web_search', arguments: { query: 'more' } }] };
    });
    expect(result.state).toBe('completed');
    expect(await prisma.agentWebRequest.count({ where: { runId: run.id } })).toBe(0);
    expect((await prisma.message.findMany({ where: { conversationId: run.conversationId, role: 'assistant' } }))[0].content).toContain('其余部分尚未核实');
    expect(result.modelMessagesJson).not.toContain('【本任务联网预算】');
  });
  it('streams the fallback answer if the model still emits a research call in the final round', async () => {
    const run = await seeded(true);
    const result = await runUntilSettled(run.id, async function* () {
      yield { toolCalls: [{ id: 'more', name: 'web_search', arguments: { query: 'extra' } }] };
    });
    expect(result.state).toBe('completed');
    const deltas = await prisma.agentRunEvent.findMany({ where: { runId: run.id, type: 'message_delta' } });
    expect(JSON.stringify(deltas)).toContain('本次资料检索已结束');
  });
  it.each([['legacy', false, false, false], ['business', true, true, false], ['write-intent', true, false, true]] as const)('preserves normal tools and round-limit pause for %s runs', async (_name, policy, business, writeIntent) => {
    const run = await seeded(policy, business, writeIntent);
    const result = await runUntilSettled(run.id, async function* (_messages, _signal, _includeTools, tools) {
      expect(tools!.some(tool => tool.function.name === 'web_search')).toBe(true);
      yield { toolCalls: [{ id: 'time', name: 'get_time', arguments: {} }] };
    });
    expect(result.state).toBe('paused');
    expect(result.pauseReason).toBe('round_limit');
  });
});
