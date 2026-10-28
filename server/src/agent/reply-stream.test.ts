import { readAssistantReasoning, REASONING_LIMIT } from '../domain/assistant-reasoning.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '../infrastructure/prisma.js';
import { AgentService, ModelAdapter, type ModelDelta } from '../agent.js';
import { ContextService } from '../application/conversation.js';
import { scheduleRun, stopRun, type ModelStream } from './runs.js';
const ids: string[] = [];
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
async function until(ready: () => Promise<boolean>) { const end = Date.now() + 7000; while (Date.now() < end) { if (await ready()) return; await tick(); } throw new Error('timed out waiting for run state'); }
function barrier() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
async function fixture(stream: ModelStream) {
  const id = randomUUID(); ids.push(id); const timestamp = new Date().toISOString();
  await prisma.conversation.create({ data: { id, createdAt: timestamp, updatedAt: timestamp } });
  const user = await prisma.message.create({ data: { conversationId: id, role: 'user', content: '图文展示', createdAt: timestamp } });
  const run = await prisma.agentRun.create({ data: { conversationId: id, sourceUserMessageId: user.id, requestKey: id, requestHash: id, state: 'queued', modelMessagesJson: JSON.stringify([{ role: 'user', content: '图文展示' }]), contextJson: JSON.stringify({ schemaVersion: 2, page: 'inbox', scope: { kind: 'all' }, taskId: null, materialId: null, selectedTaskIds: [], taskFilter: null, timeZone: 'Asia/Shanghai', timeZoneSource: 'default', referencedApprovalId: null }), cursorJson: JSON.stringify({ schemaVersion: 1, phase: 'model', round: 0, budgetEndRound: 16, assistantMessageId: null, nextToolIndex: 0 }), createdAt: timestamp, updatedAt: timestamp } });
  await prisma.conversation.update({ where: { id }, data: { activeRunId: run.id } });
  scheduleRun(run.id, stream, new ContextService());
  return { conversationId: id, runId: run.id };
}
const delta = (argumentsDelta: string): ModelDelta => ({ toolDelta: { index: 0, id: 'presentation', name: 'present_reply', argumentsDelta } });
afterEach(async () => {
  for (const id of ids.splice(0)) {
    await prisma.agentRunEvent.deleteMany({ where: { run: { conversationId: id } } });
    await prisma.agentRun.deleteMany({ where: { conversationId: id } });
    await prisma.conversation.delete({ where: { id } });
  }
});
describe('persisted incremental presentation', () => {
  it('persists text before quote closes and a complete diagram while next text is incomplete, with atomic snapshot watermarks', async () => {
    const first = barrier(); const second = barrier();
    const parts = ['{"blocks":[{"type":"text","markdown":"第一段😀', '"},{"type":"mermaid","source":"flowchart LR; A-->B"},{"type":"text","markdown":"下一段', '"}]}'];
    const { conversationId, runId } = await fixture(async function* () {
      yield delta(parts[0]); await first.promise; yield delta(parts[1]); await second.promise; yield delta(parts[2]);
      yield { toolCalls: [{ id: 'presentation', name: 'present_reply', arguments: JSON.parse(parts.join('')) }] };
    });
    try {
      await until(async () => Boolean(await prisma.agentRunEvent.findFirst({ where: { runId, type: 'block_delta' } })));
      const before = await new AgentService().snapshot(conversationId);
      expect(before.messages.at(-1)?.content).toContain('第一段😀');
      expect(before.messages.at(-1)?.status).toBe('streaming');
      expect(await prisma.agentRunEvent.count({ where: { runId, type: 'message_end' } })).toBe(0);
      first.release();
      await until(async () => (await prisma.agentRunEvent.findMany({ where: { runId, type: 'block_commit' } })).length >= 2);
      const middle = await new AgentService().snapshot(conversationId);
      const blocks = JSON.parse(middle.messages.at(-1)!.blocksJson!).blocks;
      expect(blocks.slice(0, 2).map((block: any) => block.status)).toEqual(['ready', 'ready']);
      expect(middle.watermarks[runId]).toBe((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).nextEventSeq);
      expect(middle.messages.at(-1)?.status).toBe('streaming');
      second.release();
      await until(async () => (await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).state === 'completed');
      const final = await new AgentService().snapshot(conversationId);
      expect(JSON.parse(final.messages.at(-1)!.blocksJson!).blocks.map((block: any) => block.type)).toEqual(['text', 'mermaid', 'text']);
      expect(final.messages.at(-1)?.toolCalls).toBeNull();
      expect(await prisma.approval.count({ where: { conversationId } })).toBe(0);
    } finally { first.release(); second.release(); }
  });
  it('materializes normal text with the same event watermark before EOF', async () => {
    const held = barrier();
    const { conversationId, runId } = await fixture(async function* () { yield { text: '第一段' }; await held.promise; yield { text: '第二段' }; });
    try {
      await until(async () => Boolean(await prisma.agentRunEvent.findFirst({ where: { runId, type: 'message_delta' } })));
      const snapshot = await new AgentService().snapshot(conversationId);
      expect(snapshot.messages.at(-1)?.content).toBe('第一段');
      expect(snapshot.messages.at(-1)?.status).toBe('streaming');
      held.release();
      await until(async () => (await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).state === 'completed');
      expect((await new AgentService().snapshot(conversationId)).messages.at(-1)?.content).toBe('第一段第二段');
    } finally { held.release(); }
  });
  it('aborts the upstream on stop and prevents late chunks from writing', async () => {
    const held = barrier(); let signal: AbortSignal | undefined;
    const { conversationId, runId } = await fixture(async function* (_messages, currentSignal) {
      signal = currentSignal; yield delta('{"blocks":[{"type":"text","markdown":"保留'); await held.promise;
      yield delta('迟到"}]}'); yield { toolCalls: [{ id: 'presentation', name: 'present_reply', arguments: { blocks: [] } }] };
    });
    try {
      await until(async () => Boolean(await prisma.agentRunEvent.findFirst({ where: { runId, type: 'block_delta' } })));
      await stopRun(runId); expect(signal?.aborted).toBe(true);
      const snapshot = await new AgentService().snapshot(conversationId);
      expect(snapshot.messages.at(-1)?.content).toContain('保留'); expect(snapshot.messages.at(-1)?.content).not.toContain('迟到');
      expect(JSON.parse(snapshot.messages.at(-1)!.blocksJson!).blocks[0].status).toBe('error');
      const count = await prisma.agentRunEvent.count({ where: { runId } }); held.release(); await tick(); await tick();
      expect(await prisma.agentRunEvent.count({ where: { runId } })).toBe(count);
    } finally { held.release(); }
  });
  it('keeps a valid media block after malformed trailing JSON and never executes mixed business calls', async () => {
    const { conversationId, runId } = await fixture(async function* () {
      yield delta('{"blocks":[{"type":"mermaid","source":"flowchart LR; A-->B"},{"type":"text","markdown":"未完成');
      yield delta('"},BAD');
    });
    await until(async () => (await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).state === 'failed');
    const snapshot = await new AgentService().snapshot(conversationId);
    expect(JSON.parse(snapshot.messages.at(-1)!.blocksJson!).blocks[0].status).toBe('ready');
    const mixed = await fixture(async function* () {
      const args = { blocks: [{ type: 'text', markdown: '展示不能执行任务修改' }] };
      yield delta(JSON.stringify(args));
      yield { toolCalls: [{ id: 'presentation', name: 'present_reply', arguments: args }, { id: 'write', name: 'propose_changes', arguments: {} }] };
    });
    await until(async () => (await prisma.agentRun.findUniqueOrThrow({ where: { id: mixed.runId } })).state === 'failed');
    expect(await prisma.approval.count({ where: { conversationId: mixed.conversationId } })).toBe(0);
  });
});


describe('provider reasoning display and replay', () => {
  it('persists batched thinking with snapshot watermarks and keeps the answer separate', async () => {
    const held = barrier();
    const { conversationId, runId } = await fixture(async function* () { yield { reasoning: '先核对已有记录。' }; await held.promise; yield { reasoning: '再给出建议。' }; yield { text: '这是回答。' }; });
    try {
      await until(async () => Boolean(await prisma.agentRunEvent.findFirst({ where: { runId, type: 'reasoning_delta' } })));
      const live = await new AgentService().snapshot(conversationId);
      expect(live.messages.at(-1)?.reasoning).toMatchObject({ text: '先核对已有记录。', status: 'streaming' });
      expect(live.messages.at(-1)?.content).toBe('');
      held.release();
      await until(async () => (await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).state === 'completed');
      const final = await new AgentService().snapshot(conversationId);
      expect(final.messages.at(-1)?.reasoning).toMatchObject({ text: '先核对已有记录。再给出建议。', status: 'completed' });
      expect(final.messages.at(-1)?.reasoning?.endedAt).toBeTruthy();
      expect(final.messages.at(-1)?.content).toBe('这是回答。');
      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
      expect(run.modelMessagesJson).not.toContain('先核对已有记录');
    } finally { held.release(); }
  });
  it('retains received thinking on stop and rejects late chunks', async () => {
    const held = barrier();
    const { conversationId, runId } = await fixture(async function* () { yield { reasoning: '已收到内容。' }; await held.promise; yield { reasoning: '迟到内容。' }; });
    try {
      await until(async () => Boolean(await prisma.agentRunEvent.findFirst({ where: { runId, type: 'reasoning_delta' } })));
      await stopRun(runId);
      const stopped = await new AgentService().snapshot(conversationId);
      expect(stopped.messages.at(-1)?.reasoning).toMatchObject({ text: '已收到内容。', status: 'interrupted' });
      expect(stopped.messages.at(-1)?.reasoning?.endedAt).toBeTruthy();
    } finally { held.release(); }
  });
  it('bounds long thinking and records truncation without truncating the answer', async () => {
    const { conversationId, runId } = await fixture(async function* () { yield { reasoning: '想'.repeat(REASONING_LIMIT + 1) }; yield { text: '完整回答' }; });
    await until(async () => (await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).state === 'completed');
    const final = await new AgentService().snapshot(conversationId);
    expect(final.messages.at(-1)?.reasoning?.text).toHaveLength(REASONING_LIMIT);
    expect(final.messages.at(-1)?.reasoning?.truncated).toBe(true);
    expect(final.messages.at(-1)?.content).toBe('完整回答');
  });
  it('parses provider reasoning fields independently from text, and ignores absent content', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response([
      { choices: [{ delta: { reasoning_content: '第一段' } }] },
      { choices: [{ delta: { reasoning: '第二段' } }] },
      { choices: [{ delta: { content: '正文' } }] },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'));
    try {
      const adapter = new ModelAdapter({ credentials: async () => ({ baseUrl: 'https://model.invalid', model: 'fixture', apiKey: 'fixture' }) } as any);
      const chunks = []; for await (const chunk of adapter.stream([])) chunks.push(chunk);
      expect(chunks).toEqual([{ reasoning: '第一段' }, { reasoning: '第二段' }, { text: '正文' }]);
      expect(readAssistantReasoning('[]')).toBeUndefined();
    } finally { fetchMock.mockRestore(); }
  });
});
