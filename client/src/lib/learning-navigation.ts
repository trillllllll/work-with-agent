import type { LearningNode } from '@/components/learning/learning-model.js';

/** Defensive against historical orphan/cyclic structures; a path is navigation, never a prerequisite claim. */
export function learningNodePath(nodes: LearningNode[], nodeId: string): LearningNode[] {
  const path: LearningNode[] = [];
  const visited = new Set<string>();
  let current = nodes.find(node => node.id === nodeId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id); path.unshift(current);
    current = nodes.find(node => node.id === current?.parentId);
  }
  return path;
}
export type LearningLocation = { mapId: string; nodeId: string; sessionId: string; tab: string };
export function readLearningLocation(hash: string): LearningLocation {
  const query = new URLSearchParams(hash.split('?')[1] ?? '');
  return { mapId: query.get('map') ?? '', nodeId: query.get('node') ?? '', sessionId: query.get('session') ?? '', tab: query.get('tab') ?? 'note' };
}
export function learningHash(location: Partial<LearningLocation>) {
  const query = new URLSearchParams();
  if (location.mapId) query.set('map', location.mapId);
  if (location.nodeId) query.set('node', location.nodeId);
  if (location.sessionId) query.set('session', location.sessionId);
  if (location.tab && location.tab !== 'note') query.set('tab', location.tab);
  return `#/learning${query.size ? `?${query}` : ''}`;
}
