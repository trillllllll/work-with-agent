import { createHash } from 'node:crypto';

export function builtinToolMessageId(runId: string, assistantMessageId: string, toolCallId: string) {
  return `tool_${createHash('sha256').update(`${runId}:${assistantMessageId}:${toolCallId}`).digest('hex').slice(0, 24)}`;
}
