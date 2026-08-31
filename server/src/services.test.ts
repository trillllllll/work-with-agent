import { describe, expect, it } from 'vitest';
import { TaskService, TopicService } from './services.js';

describe('application services', () => {
  it('exposes task and topic service boundaries', () => {
    expect(new TaskService()).toBeInstanceOf(TaskService);
    expect(new TopicService()).toBeInstanceOf(TopicService);
  });
});
