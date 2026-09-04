import { describe, expect, it } from 'vitest';
import { TaskService, TopicService, ToolService } from './services.js';

describe('application services', () => {
  it('exposes task and topic service boundaries', () => {
    expect(new TaskService()).toBeInstanceOf(TaskService);
    expect(new TopicService()).toBeInstanceOf(TopicService);
  });

  it('validates registered tool names, required fields, and enum values', () => {
    const tools = new ToolService();
    expect(tools.definitions()).toHaveLength(11);
    expect(tools.validate({ name: 'list_tasks', arguments: {} })).toBeNull();
    expect(tools.validate({ name: 'missing_tool', arguments: {} })).toContain('未知 Tool');
    expect(tools.validate({ name: 'create_task', arguments: { title: '缺少主题' } })).toContain('缺少参数');
    expect(tools.validate({ name: 'update_task', arguments: { taskId: 'x', status: 'invalid' } })).toContain('status');
    expect(tools.isReadOnly('list_tasks')).toBe(true);
    expect(tools.isReadOnly('create_task')).toBe(false);
  });
});
