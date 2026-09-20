import { DomainError } from './task.js';

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';

export class Approval {
  private constructor(public readonly id: string, private currentStatus: ApprovalState) {}

  static restore(value: { id: string; status: ApprovalState }) { return new Approval(value.id, value.status); }
  get status() { return this.currentStatus; }

  approve() { this.expect('pending'); this.currentStatus = 'approved'; }
  reject() { this.expect('pending'); this.currentStatus = 'rejected'; }
  executed() { this.expect('approved'); this.currentStatus = 'executed'; }
  failed() { this.expect('approved'); this.currentStatus = 'failed'; }

  private expect(expected: ApprovalState) {
    if (this.currentStatus !== expected) throw new DomainError('APPROVAL_ALREADY_HANDLED', '该审核已处理');
  }
}
