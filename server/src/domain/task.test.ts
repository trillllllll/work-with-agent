import { describe, expect, it } from 'vitest';
import { Task, allowedTaskTransitions } from './task.js';

describe('Task domain model', () => {
  it('allows only the agreed recoverable status transitions', () => {
    expect(allowedTaskTransitions('todo')).toEqual(['doing', 'done']);
    expect(allowedTaskTransitions('doing')).toEqual(['todo', 'blocked', 'done']);
    expect(allowedTaskTransitions('blocked')).toEqual(['todo', 'doing', 'done']);
    expect(allowedTaskTransitions('done')).toEqual(['todo']);

    const task = Task.restore({ id: 'task-1', status: 'todo', topicId: null, deletedAt: null });
    task.transitionTo('doing');
    task.transitionTo('blocked');
    task.transitionTo('doing');
    task.transitionTo('done');
    task.transitionTo('done');
    expect(task.status).toBe('done');
  });

  it('rejects invalid transitions and edits to trashed tasks', () => {
    const task = Task.restore({ id: 'task-1', status: 'todo', topicId: null, deletedAt: null });
    expect(() => task.transitionTo('blocked')).toThrowError(expect.objectContaining({ code: 'TASK_STATUS_TRANSITION_NOT_ALLOWED' }));

    const trashed = Task.restore({ id: 'task-2', status: 'todo', topicId: null, deletedAt: '2026-09-20T00:00:00.000Z' });
    expect(() => trashed.transitionTo('doing')).toThrowError(expect.objectContaining({ code: 'TASK_NOT_EDITABLE' }));
  });

  it('completes ordinary and blocked tasks directly, and reopens to todo', () => {
    for (const status of ['todo', 'doing', 'blocked'] as const) {
      const task = Task.restore({ id: `task-${status}`, status, topicId: null, deletedAt: null });
      task.transitionTo('done');
      task.transitionTo('todo');
      expect(task.status).toBe('todo');
    }
  });
});
