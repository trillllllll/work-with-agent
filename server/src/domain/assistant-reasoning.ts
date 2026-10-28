/** Provider-returned display content; kept separate from answers and model replay. */
export type AssistantReasoning = {
  text: string;
  startedAt: string;
  endedAt?: string;
  status: 'streaming' | 'completed' | 'interrupted';
  truncated?: boolean;
};
export const REASONING_LIMIT = 65536;
export function readAssistantReasoning(raw: string | null | undefined): AssistantReasoning | undefined {
  try {
    const part = JSON.parse(raw || '[]').find((part: { type?: string }) => part.type === 'assistant_reasoning');
    if (!part || typeof part.text !== 'string' || !part.text || !Number.isFinite(Date.parse(part.startedAt))) return undefined;
    if (!['streaming', 'completed', 'interrupted'].includes(part.status)) return undefined;
    return { text: part.text, startedAt: part.startedAt, status: part.status,
      ...(part.endedAt && Number.isFinite(Date.parse(part.endedAt)) ? { endedAt: part.endedAt } : {}),
      ...(part.truncated ? { truncated: true } : {}) };
  } catch { return undefined; }
}
