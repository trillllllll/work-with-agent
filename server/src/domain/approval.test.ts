import { describe, expect, it } from 'vitest';
import { Approval } from './approval.js';

describe('Approval domain model', () => {
  it('allows one terminal path from pending', () => {
    const approval = Approval.restore({ id: 'approval-1', status: 'pending' });
    approval.approve();
    approval.executed();
    expect(approval.status).toBe('executed');
    expect(() => approval.reject()).toThrowError(expect.objectContaining({ code: 'APPROVAL_ALREADY_HANDLED' }));
  });

  it('allows rejected and failed terminal states only from valid predecessors', () => {
    const rejected = Approval.restore({ id: 'approval-2', status: 'pending' });
    rejected.reject();
    expect(rejected.status).toBe('rejected');
    const failed = Approval.restore({ id: 'approval-3', status: 'approved' });
    failed.failed();
    expect(failed.status).toBe('failed');
  });
});
