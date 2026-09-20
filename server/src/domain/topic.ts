import { DomainError } from './task.js';

export type TopicSummaryStatus = 'empty' | 'draft' | 'confirmed';

export class Topic {
  private constructor(
    public readonly id: string,
    private draftSummary: string,
    private finalSummary: string,
    private summaryStatus: TopicSummaryStatus,
    public readonly archivedAt: string | null,
  ) {}

  static restore(value: { id: string; draftSummary: string; finalSummary: string; summaryStatus: string; archivedAt: string | null }) {
    return new Topic(value.id, value.draftSummary, value.finalSummary, value.summaryStatus as TopicSummaryStatus, value.archivedAt);
  }

  proposeSummary(summary: string) {
    this.ensureActive();
    if (!summary.trim()) throw new DomainError('TOPIC_SUMMARY_EMPTY', '成果草稿不能为空', 400);
    this.draftSummary = summary;
    this.summaryStatus = 'draft';
  }

  confirmSummary() {
    this.ensureActive();
    if (!this.draftSummary) throw new DomainError('TOPIC_SUMMARY_NOT_PROPOSED', '没有待确认的成果草稿', 400);
    this.finalSummary = this.draftSummary;
    this.draftSummary = '';
    this.summaryStatus = 'confirmed';
  }

  discardSummary() {
    this.ensureActive();
    this.draftSummary = '';
    this.summaryStatus = this.finalSummary ? 'confirmed' : 'empty';
  }

  summaryState() { return { draftSummary: this.draftSummary, finalSummary: this.finalSummary, summaryStatus: this.summaryStatus }; }

  private ensureActive() {
    if (this.archivedAt) throw new DomainError('TOPIC_ARCHIVED', '已归档主题不能修改');
  }
}
