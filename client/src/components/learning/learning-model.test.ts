import { expect, it } from 'vitest';
import { learningRecommendations, type LearningNode } from './learning-model.js';

function node(id: string, status: string, parentId = 'first', mapId = 'map'): LearningNode {
  return { id, status, parentId, mapId, kind: 'item', title: id, detail: '', mastery: 0, sortOrder: 0, revision: 1, children: [] };
}
it('recommends saved review and learning states across groups ahead of adjacent unread nodes', () => {
  const current = node('current', 'learning');
  const rows = [current, node('adjacent', 'todo'), node('in-progress', 'learning', 'other'), node('review', 'review', 'third')];
  expect(learningRecommendations(rows, current).map(row => row.id)).toEqual(['review', 'in-progress']);
  expect(rows.map(row => row.status)).toEqual(['learning', 'todo', 'learning', 'review']);
});
it('excludes the current point, completed content, groups and other topics without inventing a next step', () => {
  const current = node('current', 'review');
  expect(learningRecommendations([current, node('done', 'done'), node('foreign', 'review', 'first', 'other-map'), { ...node('group', 'learning'), kind: 'topic' }], current)).toEqual([]);
  expect(learningRecommendations([current, node('unread', 'todo')], current).map(row => row.id)).toEqual(['unread']);
});
