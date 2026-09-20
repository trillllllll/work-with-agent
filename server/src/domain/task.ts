export type TaskStatusValue = 'todo' | 'doing' | 'blocked' | 'done';

const transitions: Record<TaskStatusValue, readonly TaskStatusValue[]> = {
  todo: ['doing'],
  doing: ['todo', 'blocked', 'done'],
  blocked: ['todo', 'doing'],
  done: ['doing'],
};

export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
  }
}

export function allowedTaskTransitions(status: TaskStatusValue): TaskStatusValue[] {
  return [...transitions[status]];
}

export class Task {
  private constructor(
    public readonly id: string,
    private currentStatus: TaskStatusValue,
    public readonly topicId: string | null,
    public readonly deletedAt: string | null,
  ) {}

  static restore(value: { id: string; status: TaskStatusValue; topicId: string | null; deletedAt: string | null }) {
    return new Task(value.id, value.status, value.topicId, value.deletedAt);
  }

  get status() { return this.currentStatus; }
  get allowedTransitions() { return allowedTaskTransitions(this.currentStatus); }

  transitionTo(next: TaskStatusValue) {
    if (this.deletedAt) throw new DomainError('TASK_NOT_EDITABLE', '回收站中的任务不能直接修改');
    if (next === this.currentStatus) return;
    if (!transitions[this.currentStatus].includes(next)) {
      throw new DomainError('TASK_STATUS_TRANSITION_NOT_ALLOWED', `任务不能从 ${this.currentStatus} 转换为 ${next}`);
    }
    this.currentStatus = next;
  }
}
