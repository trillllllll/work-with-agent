// Test fixture support: old deterministic scripts have no model reasoning step
// to discover new schemas. Teach fixtures the real load_tools handshake rather
// than weakening production execution gates or bypassing approval validation.
import type { ModelMessage, ModelToolDefinition } from '../agent.js';
import type { ToolGroup } from './tool-loading.js';
import type { ModelStream } from './runs.js';

export function withTestToolLoading(stream: ModelStream): ModelStream {
  return async function* (messages, signal, includeTools, tools) {
    const discovery = testDiscovery(tools);
    if (discovery) { yield discovery; return; }
    yield* stream(withoutDiscovery(messages), signal, includeTools, tools);
  };
}

export const regressionGroups: ToolGroup[] = ['tasks', 'library', 'memory', 'orchestration', 'external', 'workspace_write', 'library_write', 'memory_write', 'skill_write', 'media'];
export function testDiscovery(tools?: ModelToolDefinition[]) {
  if (!tools?.some(t => t.function.name === 'load_tools')) return null;
  const schema = tools.find(t => t.function.name === 'propose_changes')?.function.parameters as any;
  if (schema?.properties.operations.items.oneOf.length === 4 && tools.some(t => t.function.name === 'present_reply') && tools.some(t => t.function.name === 'library_read')) return null;
  return { toolCalls: [{ id: 'fixture-load-tools', name: 'load_tools', arguments: { groups: regressionGroups } }] };
}
export function withoutDiscovery(messages: ModelMessage[]) {
  const ids = new Set(messages.flatMap(m => (m.tool_calls ?? []).filter(c => c.function.name === 'load_tools').map(c => c.id)));
  return messages.flatMap(m => {
    if (m.role === 'tool' && ids.has(m.tool_call_id ?? '')) return [];
    if (!m.tool_calls) return [m];
    const calls = m.tool_calls.filter(c => !ids.has(c.id));
    return calls.length ? [{ ...m, tool_calls: calls }] : m.content ? [{ ...m, tool_calls: undefined }] : [];
  });
}
