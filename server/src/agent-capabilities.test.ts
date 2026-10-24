import { withTestToolLoading } from './agent/test-model-tools.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentService, type ModelMessage } from './agent.js';
import type { ToolCall } from './application/workspace.js';
import { builtinToolDefinitions } from './agent/capabilities.js';
import { ControlledExecutionAdapter } from './infrastructure/controlled-execution.js';

function userText(messages: ModelMessage[]) {
  return String([...messages].reverse().find((message) => message.role === 'user')?.content ?? '');
}

function agentFor(script: (messages: ModelMessage[]) => { text?: string; toolCalls?: ToolCall[] }) {
  return new AgentService({
    stream: withTestToolLoading(async function* (messages: ModelMessage[]) {
      const delta = script(messages);
      if (delta.text) yield { text: delta.text };
      if (delta.toolCalls?.length) yield { toolCalls: delta.toolCalls };
    }),
  } as never);
}

describe('builtin capability boundary', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('offers the explicit builtin tools including read-only presentation and image search', () => {
    const toolNames = builtinToolDefinitions().map((tool) => tool.function.name);
    expect(toolNames).toEqual([
      'present_reply', 'image_search', 'read_app_knowledge', 'read_page_state', 'get_time', 'list_plan_time_bands', 'get_work_context', 'query_tasks', 'query_topics', 'get_task_activity', 'search_workspace',
      'library_read', 'memory_read', 'conversation_search', 'get_change_schema', 'propose_changes', 'prepare_external_prompt', 'orchestration_read', 'orchestration_stats', 'propose_worktree_cleanup',
    ]);
    expect(toolNames).not.toEqual(expect.arrayContaining(['execute_shell', 'execute_file', 'execute_http', 'delete_topic']));
    expect(toolNames).toContain('get_time');
    expect(toolNames).toContain('get_task_activity');
    expect(toolNames).toContain('prepare_external_prompt');
  });

  it('refuses a fake model that calls removed execution tools', async () => {
    const spy = vi.spyOn(ControlledExecutionAdapter.prototype, 'execute');
    const before = spy.mock.calls.length;
    const agent = agentFor((messages) => {
      if (messages.some((message) => message.role === 'tool')) return { text: '这些操作没有执行。' };
      if (!userText(messages).includes('越界执行')) return { text: '好的。' };
      return {
        toolCalls: [
          { id: 'bad_shell', name: 'execute_shell', arguments: { command: 'rm -rf /' } },
          { id: 'bad_file', name: 'execute_file', arguments: { operation: 'read', path: '/etc/passwd' } },
          { id: 'bad_http', name: 'execute_http', arguments: { url: 'https://example.invalid' } },
          { id: 'bad_topic', name: 'delete_topic', arguments: { topicId: 'topic' } },
          { id: 'bad_ask', name: 'library_read', arguments: { action: 'ask', question: '总结全部资料' } },
        ],
      };
    });
    const result = await agent.chat({ message: '越界执行这些外部动作', pageContext: { page: 'inbox' } });
    const attempts = result.events.filter((event) => event.type === 'tool_result' && event.toolName !== 'load_tools');
    expect(attempts).toHaveLength(5);
    for (const attempt of attempts) expect(attempt.result).toMatchObject({ success: false, code: 'CAPABILITY_UNAVAILABLE' });
    expect(spy.mock.calls.length).toBe(before);
    expect(result.events.some((event) => event.type === 'approval_required')).toBe(false);
  });
});
