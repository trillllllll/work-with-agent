export type AssistantSource = { kind: 'task' | 'material' | 'memory' | 'conversation' | 'help' | 'learning_node' | 'learning_map' | 'learning_item'; id: string; title: string; revision?: number; createdAt?: string };

export function uniqueAssistantSources(sources: AssistantSource[]) {
  const seen = new Set<string>();
  return sources.filter(source => {
    const key = `${source.kind}:${source.id}:${source.revision ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
