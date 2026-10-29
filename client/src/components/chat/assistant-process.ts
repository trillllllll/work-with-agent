import { isReadOnlyTool, type ChatMessage, type ToolActivity } from '@/chat.js';

/** Approval-bearing calls always stay outside the collapsible process. */
export function isProcessTool(tool: ToolActivity) {
  return !tool.approvalId && tool.status !== 'pending' && (tool.name === 'load_skill' || isReadOnlyTool(tool.name, tool.arguments));
}

/** Group adjacent rounds only; never cross a user/system message or a run boundary. */
export function assistantTurns(messages: ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = [];
  for (const message of messages) {
    const turn = turns[turns.length - 1];
    const previous = turn?.[turn.length - 1];
    if (previous?.role === 'assistant' && message.role === 'assistant' && previous.runId === message.runId) turn.push(message);
    else turns.push([message]);
  }
  return turns;
}

export function processState(messages: ChatMessage[], runActive = false) {
  const tools = messages.flatMap(message => message.tools ?? []).filter(isProcessTool);
  const reasoning = messages.filter(message => message.reasoning?.text);
  const runningTool = messages.filter(message => runActive || message.status === 'streaming').flatMap(message => message.tools ?? []).reverse().find(tool => isProcessTool(tool) && tool.status === 'running');
  const thinking = reasoning.some(message => message.status === 'streaming' && message.reasoning?.status === 'streaming');
  const interrupted = messages.some(message => message.status === 'failed' ||
    (!runActive && message.status !== 'streaming' && message.tools?.some(tool => isProcessTool(tool) && tool.status === 'running')) ||
    (message.reasoning?.text && (message.reasoning.status === 'interrupted' || (message.status !== 'streaming' && message.reasoning.status === 'streaming'))));
  return { tools, reasoning, runningTool, thinking, processing: runActive || messages.some(message => message.status === 'streaming'), interrupted, failed: tools.filter(tool => tool.status === 'error').length,
    queries: tools.filter(tool => tool.name !== 'load_skill').length, skills: tools.filter(tool => tool.name === 'load_skill').length };
}
