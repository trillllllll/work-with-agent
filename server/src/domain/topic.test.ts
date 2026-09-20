import { describe, expect, it } from 'vitest';
import { Topic } from './topic.js';

describe('Topic domain model', () => {
  it('owns the summary lifecycle', () => {
    const topic = Topic.restore({ id: 'topic-1', draftSummary: '', finalSummary: '', summaryStatus: 'empty', archivedAt: null });
    topic.proposeSummary('阶段结论');
    expect(topic.summaryState()).toEqual({ draftSummary: '阶段结论', finalSummary: '', summaryStatus: 'draft' });
    topic.confirmSummary();
    expect(topic.summaryState()).toEqual({ draftSummary: '', finalSummary: '阶段结论', summaryStatus: 'confirmed' });
    topic.proposeSummary('新草稿');
    topic.discardSummary();
    expect(topic.summaryState()).toEqual({ draftSummary: '', finalSummary: '阶段结论', summaryStatus: 'confirmed' });
  });

  it('rejects confirming without a draft and changing archived topics', () => {
    const topic = Topic.restore({ id: 'topic-1', draftSummary: '', finalSummary: '', summaryStatus: 'empty', archivedAt: null });
    expect(() => topic.confirmSummary()).toThrowError(expect.objectContaining({ code: 'TOPIC_SUMMARY_NOT_PROPOSED' }));
    const archived = Topic.restore({ id: 'topic-2', draftSummary: '', finalSummary: '', summaryStatus: 'empty', archivedAt: '2026-09-20T00:00:00.000Z' });
    expect(() => archived.proposeSummary('不可写')).toThrowError(expect.objectContaining({ code: 'TOPIC_ARCHIVED' }));
  });
});
