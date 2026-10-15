import { describe, expect, it } from 'vitest';
import { reviewCardState, reviewStatusCopy, type Approval } from './chat.js';

const review = {
  schemaVersion: 1 as const,
  title: '修改 1 个任务',
  intent: '改到明天',
  requestedOperationCount: 1,
  commandCount: 1,
  affectedEntityCount: 1,
  relatedEntityCount: 0,
  atomic: true as const,
  reversibility: 'supported' as const,
  reversibilityReason: null,
  consequences: ['安排变为 2026-10-15 → 2026-10-16。'],
  entities: [],
  previewHash: 'a'.repeat(64),
};

function approval(patch: Partial<Approval> = {}): Approval {
  return { approvalId: 'a1', toolName: 'propose_changes', arguments: {}, status: 'pending', resultState: 'app_changes', appReview: review, proposalRevision: 1, previewHash: review.previewHash, ...patch };
}

describe('approval card state', () => {
  it('shows a pending change and locks the card while the decision is in flight', () => {
    const pending = approval();
    expect(reviewCardState(pending, '', false)).toBe('pending');
    expect(reviewStatusCopy('pending', pending)).toBe('等待确认');
    expect(reviewCardState(pending, 'approve', false)).toBe('approving');
    expect(reviewStatusCopy('approving', pending)).toBe('正在修改…');
    expect(reviewCardState(pending, 'reject', false)).toBe('rejecting');
    expect(reviewStatusCopy('rejecting', pending)).toBe('正在取消…');
  });

  it('keeps a lost response unknown until the server confirms it', () => {
    const pending = approval();
    expect(reviewCardState(pending, '', true)).toBe('unknown');
    expect(reviewStatusCopy('unknown', pending, false)).toBe('正在核对执行结果…');
    expect(reviewStatusCopy('unknown', pending, true)).toBe('结果待核对');
  });

  it('keeps the executed card and separates a later answer failure from the business result', () => {
    const executed = approval({ status: 'executed', appOutcome: { status: 'executed', appliedOperationCount: 1, changeId: 'c1', completedAt: '2026-10-15T03:00:00.000Z' } });
    expect(reviewCardState(executed, '', false)).toBe('executed');
    expect(reviewStatusCopy('executed', executed)).toBe('已修改 1 个对象');
  });

  it('uses the conflict copy and does not treat cancel as a failure', () => {
    const conflict = approval({ status: 'failed', appOutcome: { status: 'failed', appliedOperationCount: 0, code: 'VERSION_CONFLICT', message: '内容已变化，本次未修改', completedAt: '2026-10-15T03:00:00.000Z' } });
    expect(reviewStatusCopy('failed', conflict)).toBe('内容已变化，本次未修改');
    const rejected = approval({ status: 'rejected', appOutcome: { status: 'rejected', appliedOperationCount: 0, code: 'REJECTED', message: '已取消，未修改数据', completedAt: '2026-10-15T03:00:00.000Z' } });
    expect(reviewCardState(rejected, '', false)).toBe('rejected');
    expect(reviewStatusCopy('rejected', rejected)).toBe('已取消，未修改数据');
  });

  it('blocks removed capabilities and unreadable history', () => {
    expect(reviewCardState(approval({ toolName: 'execute_file' }), '', false)).toBe('capability_removed');
    expect(reviewStatusCopy('capability_removed', approval({ toolName: 'execute_file' }))).toBe('此能力已移出内置 AI');
    expect(reviewCardState(approval({ resultState: 'unreadable', appReview: undefined, status: 'pending' }), '', false)).toBe('unreadable');
  });
});
