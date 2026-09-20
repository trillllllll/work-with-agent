import { describe, expect, it } from 'vitest';
import { availableTaskStatuses } from './api.js';

describe('task status options', () => {
  it('keeps the current status and exposes only allowed targets', () => {
    expect(availableTaskStatuses({ status: 'todo', allowedTransitions: ['doing'] })).toEqual(['todo', 'doing']);
    expect(availableTaskStatuses({ status: 'done', allowedTransitions: ['doing'] })).toEqual(['doing', 'done']);
  });
});
