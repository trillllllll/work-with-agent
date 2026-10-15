import { afterEach, describe, expect, it } from 'vitest';
import { DomainError } from './domain/task.js';
import { prisma } from './infrastructure/prisma.js';
import { AgentService, type ModelMessage } from './agent.js';
import type { ToolCall } from './application/workspace.js';
import { renderExternalPrompt } from './agent/external-prompt.js';

const secretToken = 'super-secret-token';

function rows() {
  return Promise.all([
    prisma.task.findMany({ orderBy: { id: 'asc' }, select: { id: true, title: true, revision: true, description: true, status: true } }),
    prisma.material.findMany({ orderBy: { id: 'asc' }, select: { id: true, title: true, revision: true } }),
    prisma.memory.findMany({ orderBy: { id: 'asc' }, select: { id: true, title: true, revision: true, content: true } }),
  ]);
}

describe('external prompt cards', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('renders a copyable prompt without secrets, writes, or outbound requests', async () => {
    const outbound: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(String(input));
      return originalFetch(input, init);
    }) as typeof fetch;
    const before = await rows();
    const agent = new AgentService({
      stream: async function* (messages: ModelMessage[]) {
        if (messages.some((message) => message.role === 'tool')) {
          yield { text: '提示词已经放在卡片里，可以复制。' };
          return;
        }
        const call: ToolCall = {
          id: 'call_external',
          name: 'prepare_external_prompt',
          arguments: {
            capability: 'web_research',
            limitation: '我目前不能联网查资料。',
            goal: '查询公开文档里的安装步骤',
            background: [`引用里出现 token=${secretToken}`],
            constraints: ['不要编造来源'],
            expectedOutput: ['列出结论、来源链接和日期'],
          },
        };
        yield { text: '我目前不能联网查资料。' };
        yield { toolCalls: [call] };
      },
    } as never);
    const result = await agent.chat({ message: '帮我上网查安装步骤', pageContext: { page: 'inbox' } });
    const event = result.events.find((item) => item.type === 'external_prompt');
    const part = event?.part as { type?: string; prompt?: string };
    expect(part.type).toBe('external_prompt');
    expect(part.prompt).toContain('目标');
    expect(part.prompt).toContain('请按以下格式返回');
    expect(part.prompt).not.toContain(secretToken);
    expect(await rows()).toEqual(before);
    expect(outbound).toHaveLength(0);
    const stored = await prisma.message.findMany({ where: { conversationId: result.conversationId, role: 'assistant' } });
    const owner = stored.find((message) => message.id === event?.messageId);
    expect(owner?.partsJson).toContain('"type":"external_prompt"');
    expect(stored.filter((message) => message.partsJson.includes('"type":"external_prompt"'))).toHaveLength(1);
  });

  it('rejects an over-long prompt instead of truncating it', async () => {
    const input = {
      capability: 'other' as const,
      limitation: '缺少这项能力。',
      goal: '目标'.repeat(400),
      background: Array.from({ length: 8 }, () => '背景'.repeat(400)),
      constraints: Array.from({ length: 10 }, () => '限制'.repeat(200)),
      expectedOutput: Array.from({ length: 10 }, () => '输出'.repeat(200)),
    };
    expect(() => renderExternalPrompt(input)).toThrowError(expect.objectContaining({ code: 'PROMPT_TOO_LONG' }));
    const agent = new AgentService({
      stream: async function* (messages: ModelMessage[]) {
        if (messages.some((message) => message.role === 'tool')) { yield { text: '提示词太长，没有保存。' }; return; }
        yield { toolCalls: [{ id: 'call_long', name: 'prepare_external_prompt', arguments: input }] };
      },
    } as never);
    const result = await agent.chat({ message: '整理一份特别长的外部提示词', pageContext: { page: 'inbox' } });
    expect(result.events.find((event) => event.type === 'tool_result')?.result).toMatchObject({ success: false, code: 'PROMPT_TOO_LONG' });
    const assistant = await prisma.message.findFirst({ where: { conversationId: result.conversationId, role: 'assistant' }, orderBy: { createdAt: 'asc' } });
    expect(assistant?.partsJson ?? '[]').toBe('[]');
    expect(result.events.some((event) => event.type === 'external_prompt')).toBe(false);
  });

  it('uses DomainError for the length check', () => {
    try {
      renderExternalPrompt({ capability: 'other', limitation: '缺少。', goal: '长'.repeat(1000), background: Array.from({ length: 8 }, () => '背'.repeat(1000)), constraints: Array.from({ length: 10 }, () => '限'.repeat(500)), expectedOutput: Array.from({ length: 10 }, () => '出'.repeat(500)) });
      throw new Error('should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('PROMPT_TOO_LONG');
    }
  });
});
