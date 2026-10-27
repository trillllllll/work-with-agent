import type { LearningTreeNode } from './learning-tree.js';
export type LearningNode = LearningTreeNode;
export type LearningMap = { id: string; title: string; goal: string; status: string; revision: number; updatedAt: string };
export type LearningMapSummary = LearningMap & { stats: { topics: number; items: number; itemsDone: number } };
export type LearningMapAggregate = { map: LearningMap; tree: LearningNode[]; recentActivity: Array<{ id: string; content: string; createdAt: string }> };
export const masteryStates = [
  { id: 'todo', symbol: '○', color: '--muted-foreground', fill: '--card', border: '--border' },
  { id: 'learning', symbol: '◐', color: '--tag-blue-fg', fill: '--tag-blue-bg', border: '--tag-blue-border' },
  { id: 'review', symbol: '↻', color: '--tag-amber-fg', fill: '--tag-amber-bg', border: '--tag-amber-border' },
  { id: 'done', symbol: '✓', color: '--tag-green-fg', fill: '--tag-green-bg', border: '--tag-green-border' },
] as const;
export type MasteryState = typeof masteryStates[number]['id'];
export const getMastery = (node: { status: string }) => masteryStates.find(s => s.id === node.status) ?? masteryStates[0];
export function flattenTree(tree: LearningNode[]): LearningNode[] { return tree.flatMap(node => [node, ...flattenTree(node.children)]); }
export function descendants(nodes: LearningNode[], parentId: string): LearningNode[] {
  const ids = new Set([parentId]);
  let changed = true;
  while (changed) { changed = false; for (const node of nodes) if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) { ids.add(node.id); changed = true; } }
  return nodes.filter(node => node.id !== parentId && ids.has(node.id));
}
export function masterySummary(nodes: LearningNode[], parentId?: string) {
  const own = parentId ? descendants(nodes, parentId) : nodes;
  const items = own.filter(n => n.kind === 'item');
  return { total: items.length, done: items.filter(n => n.status === 'done').length };
}
