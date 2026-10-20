import { describe, expect, it } from 'vitest';
import {
  accessCount,
  clearSelection,
  filterSelected,
  filterTopics,
  orderSelectedFirst,
  selectAll,
  topicIdsForSave,
  type AccessTopic,
} from './connection-access.js';

const alpha: AccessTopic = { id: 'a', name: 'Alpha' };
const beta: AccessTopic = { id: 'b', name: 'beta notes' };
const gamma: AccessTopic = { id: 'c', name: 'Gamma' };
const topics = [alpha, beta, gamma];

describe('connection access', () => {
  it('searches topic names without regard to case and does not search archived lists', () => {
    expect(filterTopics(topics, 'ALPHA')).toEqual([alpha]);
    expect(filterTopics(topics, '  notes ')).toEqual([beta]);
    expect(filterTopics(topics, '')).toEqual(topics);
    expect(filterTopics(topics, 'archived')).toEqual([]);
    const archived = [{ id: 'old', name: 'Alpha archived' }];
    expect(selectAll({ includeInbox: false, topicIds: [] }, topics, 'alpha').topicIds).toEqual(['a']);
    expect(selectAll({ includeInbox: false, topicIds: [] }, topics, 'alpha').topicIds).not.toContain(archived[0].id);
  });

  it('selects the inbox and every list when there is no search', () => {
    const current = { includeInbox: false, topicIds: ['archived', 'missing'] };
    expect(selectAll(current, topics, '')).toEqual({
      includeInbox: true,
      topicIds: ['a', 'b', 'c', 'archived', 'missing'],
    });
    expect(current).toEqual({ includeInbox: false, topicIds: ['archived', 'missing'] });
  });

  it('selects only matching lists when searching, and leaves the inbox and other ids alone', () => {
    const current = { includeInbox: false, topicIds: ['c', 'archived', 'missing'] };
    expect(selectAll(current, topics, 'alp')).toEqual({
      includeInbox: false,
      topicIds: ['c', 'archived', 'missing', 'a'],
    });
    expect(selectAll(current, topics, 'nope')).toEqual(current);
  });

  it('clears the inbox, lists, missing ids, and archived ids when there is no search', () => {
    expect(clearSelection({ includeInbox: true, topicIds: ['a', 'archived', 'missing'] }, topics, '  ')).toEqual({
      includeInbox: false,
      topicIds: [],
    });
  });

  it('clears only matching lists when searching', () => {
    expect(clearSelection({ includeInbox: true, topicIds: ['a', 'b', 'archived', 'missing'] }, topics, 'alpha')).toEqual({
      includeInbox: true,
      topicIds: ['b', 'archived', 'missing'],
    });
  });

  it('puts selected topics first and keeps relative order', () => {
    expect(orderSelectedFirst(topics, ['c', 'a'])).toEqual([alpha, gamma, beta]);
    expect(orderSelectedFirst(topics, [])).toEqual(topics);
    expect(orderSelectedFirst(topics, ['a', 'b', 'c'])).toEqual(topics);
  });

  it('counts the inbox in both the selected and total numbers', () => {
    expect(accessCount(topics, false, [])).toEqual({ selected: 0, total: 4 });
    expect(accessCount(topics, true, ['a'])).toEqual({ selected: 2, total: 4 });
    expect(accessCount(topics, true, ['a', 'b', 'archived', 'missing'])).toEqual({ selected: 3, total: 4 });
    expect(accessCount([], true, [])).toEqual({ selected: 1, total: 1 });
  });

  it('keeps only selected non-archived topics for the selected filter', () => {
    expect(filterSelected(topics, ['c', 'a', 'missing', 'archived'])).toEqual([alpha, gamma]);
    expect(filterSelected(topics, [])).toEqual([]);
  });

  it('drops missing ids on save and keeps archived ids that are still checked', () => {
    expect(topicIdsForSave(['live', 'gone', 'archived', 'also-gone'], ['gone', 'also-gone'])).toEqual(['live', 'archived']);
    expect(topicIdsForSave(['live'], ['gone'])).toEqual(['live']);
    expect(topicIdsForSave(['gone'], ['gone'])).toEqual([]);
  });
});
