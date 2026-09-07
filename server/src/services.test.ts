import { describe, expect, it } from 'vitest';
import { ControlledExecutionAdapter, TaskService, TopicService, ToolService } from './services.js';

describe('application services', () => {
  it('exposes task and topic service boundaries', () => {
    expect(new TaskService()).toBeInstanceOf(TaskService);
    expect(new TopicService()).toBeInstanceOf(TopicService);
  });

  it('validates registered tool names, required fields, and enum values', () => {
    const tools = new ToolService();
    expect(tools.definitions()).toHaveLength(14);
    expect(tools.validate({ name: 'list_tasks', arguments: {} })).toBeNull();
    expect(tools.validate({ name: 'missing_tool', arguments: {} })).toContain('未知 Tool');
    expect(tools.validate({ name: 'create_task', arguments: { title: '缺少主题' } })).toContain('缺少参数');
    expect(tools.validate({ name: 'update_task', arguments: { taskId: 'x', status: 'invalid' } })).toContain('status');
    expect(tools.isReadOnly('list_tasks')).toBe(true);
    expect(tools.isReadOnly('create_task')).toBe(false);
  });

  it('enforces controlled execution boundaries', async () => {
    const execution = new ControlledExecutionAdapter();
    expect((await execution.execute({ kind: 'shell', input: { command: 'powershell' }, approvalId: 'a' })).errorCode).toBe('SHELL_COMMAND_DENIED');
    expect((await execution.execute({ kind: 'file', input: { operation: 'read', path: '../outside' }, approvalId: 'a' })).errorCode).toBe('FILE_PATH_DENIED');
    expect((await execution.execute({ kind: 'http', input: { url: 'http://127.0.0.1' }, approvalId: 'a' })).errorCode).toBe('HTTP_TARGET_DENIED');
  });
});
