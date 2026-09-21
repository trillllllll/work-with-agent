import { describe, expect, it, vi } from 'vitest';
import { ChangeService, ControlledExecutionAdapter, TaskService, TopicService, ToolService, prisma, type ExecutionAdapter } from './services.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

describe('application services', () => {
  it('exposes task and topic service boundaries', () => {
    expect(new TaskService()).toBeInstanceOf(TaskService);
    expect(new TopicService()).toBeInstanceOf(TopicService);
  });

  it('validates registered tool names, required fields, and enum values', () => {
    const tools = new ToolService();
    expect(tools.definitions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: 'create_task' }) }),
      expect.objectContaining({ function: expect.objectContaining({ name: 'execute_shell' }) }),
    ]));
    expect(tools.validate({ name: 'list_tasks', arguments: {} })).toBeNull();
    expect(tools.validate({ name: 'missing_tool', arguments: {} })).toContain('未知 Tool');
    expect(tools.validate({ name: 'create_task', arguments: { title: '先放入收集箱' } })).toBeNull();
    expect(tools.validate({ name: 'update_task', arguments: { taskId: 'x', status: 'invalid' } })).toContain('status');
    expect(tools.isReadOnly('list_tasks')).toBe(true);
    expect(tools.isReadOnly('create_task')).toBe(false);
    expect(tools.isKnown('delete_topic')).toBe(true);
    expect(tools.isReadOnly('delete_topic')).toBe(false);
  });

  it('enforces controlled execution boundaries', async () => {
    const execution = new ControlledExecutionAdapter();
    expect((await execution.execute({ kind: 'shell', input: { command: 'powershell' }, approvalId: 'a' })).errorCode).toBe('SHELL_COMMAND_DENIED');
    expect((await execution.execute({ kind: 'shell', input: { command: 'node && whoami' }, approvalId: 'a' })).errorCode).toBe('SHELL_COMMAND_DENIED');
    expect((await execution.execute({ kind: 'file', input: { operation: 'read', path: '../outside' }, approvalId: 'a' })).errorCode).toBe('FILE_PATH_DENIED');
    for (const url of ['http://127.0.0.1', 'http://100.64.0.1', 'http://192.0.2.1', 'http://198.51.100.1', 'http://224.0.0.1', 'http://[::1]', 'http://[fe80::1]', 'http://[fc00::1]', 'http://[2001:db8::1]', 'http://[::ffff:127.0.0.1]']) {
      expect((await execution.execute({ kind: 'http', input: { url }, approvalId: 'a' })).errorCode, url).toBe('HTTP_TARGET_DENIED');
    }
    const dnsBlocked = new ControlledExecutionAdapter(async () => [{ address: '10.0.0.4' }]);
    expect((await dnsBlocked.execute({ kind: 'http', input: { url: 'https://example.test' }, approvalId: 'a' })).errorCode).toBe('HTTP_TARGET_DENIED');
    const dnsV6Blocked = new ControlledExecutionAdapter(async () => [{ address: 'fd00::4' }]);
    expect((await dnsV6Blocked.execute({ kind: 'http', input: { url: 'https://example.test' }, approvalId: 'a' })).errorCode).toBe('HTTP_TARGET_DENIED');
  });

  it('enforces shell timeouts and output limits', async () => {
    const execution = new ControlledExecutionAdapter();
    const timeout = await execution.execute({ kind: 'shell', input: { command: 'node', args: ['-e', 'setTimeout(() => {}, 5000)'] }, approvalId: 'a', timeoutMs: 50 });
    expect(timeout.errorCode).toBe('SHELL_TIMEOUT');
    const output = await execution.execute({ kind: 'shell', input: { command: 'node', args: ['-e', "process.stdout.write('x'.repeat(4096))"] }, approvalId: 'a', maxOutputBytes: 32 });
    expect(output.errorCode).toBe('SHELL_OUTPUT_LIMIT');
  });

  it('limits HTTP responses, enforces timeouts, and disables redirects', async () => {
    const execution = new ControlledExecutionAdapter(async () => [{ address: '93.184.216.34' }]);
    const originalFetch = globalThis.fetch;
    try {
      const oversizedFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('x'.repeat(64)));
      vi.stubGlobal('fetch', oversizedFetch);
      const oversized = await execution.execute({ kind: 'http', input: { url: 'https://example.test' }, approvalId: 'a', maxOutputBytes: 16 });
      expect(oversized.errorCode).toBe('HTTP_RESPONSE_LIMIT');
      expect(oversizedFetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });

      vi.stubGlobal('fetch', vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      })));
      const timeout = await execution.execute({ kind: 'http', input: { url: 'https://example.test' }, approvalId: 'a', timeoutMs: 20 });
      expect(timeout.errorCode).toBe('HTTP_TIMEOUT');
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('rejects symlink escape paths', async ({ skip }) => {
    const targetName = `symlink-test-${Date.now()}`;
    const target = join(process.cwd(), targetName);
    const outside = join(process.cwd(), '..', `outside-${Date.now()}.txt`);
    await fs.writeFile(outside, 'outside');
    try {
      try {
        await fs.symlink(outside, target, 'file');
      } catch (error: any) {
        if (process.platform === 'win32' && error?.code === 'EPERM') {
          skip('当前 Windows 用户没有创建符号链接的权限');
          return;
        }
        throw error;
      }
      const result = await new ControlledExecutionAdapter().execute({ kind: 'file', input: { operation: 'read', path: targetName }, approvalId: 'a' });
      expect(result.errorCode).toBe('FILE_PATH_DENIED');
    } finally {
      await fs.rm(target, { force: true });
      await fs.rm(outside, { force: true });
    }
  });

  it('rejects directory symlink or Junction escape paths', async ({ skip }) => {
    const targetName = `junction-test-${Date.now()}`;
    const target = join(process.cwd(), targetName);
    const outside = join(process.cwd(), '..', `outside-dir-${Date.now()}`);
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, 'secret.txt'), 'outside');
    try {
      try {
        await fs.symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error: any) {
        if (process.platform === 'win32' && error?.code === 'EPERM') {
          skip('当前 Windows 用户没有创建 Junction 的权限');
          return;
        }
        throw error;
      }
      const result = await new ControlledExecutionAdapter().execute({ kind: 'file', input: { operation: 'read', path: `${targetName}/secret.txt` }, approvalId: 'a' });
      expect(result.errorCode).toBe('FILE_PATH_DENIED');
    } finally {
      await fs.rm(target, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('records approved controlled executions with redacted snapshots', async () => {
    const adapter: ExecutionAdapter = { execute: async () => ({ success: true, data: { authorization: 'Bearer hidden', output: 'token=also-hidden' }, durationMs: 1, reversible: false, redacted: true }) };
    const tools = new ToolService(adapter);
    const approvalId = `approval-${Date.now()}`;
    const result = await tools.execute({ name: 'execute_http', arguments: { url: 'https://example.test?api_key=url-hidden', headers: { authorization: 'Bearer hidden' }, body: { apiKey: 'body-hidden' } } }, { source: 'agent', approvalId, conversationId: 'conversation-test' });
    expect(result.success).toBe(true);
    const record = await prisma.changeRecord.findFirst({ where: { entityType: 'execution', entityId: approvalId } });
    expect(record).toMatchObject({ entityType: 'execution', operation: 'execute', source: 'agent', approvalId, requestId: approvalId });
    expect(record?.afterSnapshot).not.toMatch(/Bearer hidden|url-hidden|body-hidden|also-hidden/);
    expect(record?.afterSnapshot).toContain('[REDACTED]');
    expect(JSON.parse(record!.afterSnapshot!).result.reversible).toBe(false);
    await expect(new ChangeService().undo(record!.id)).rejects.toThrow('受控执行记录不可撤销');
    await prisma.changeRecord.deleteMany({ where: { entityId: approvalId } });
  });

  it('does not audit controlled requests rejected during validation', async () => {
    const adapter: ExecutionAdapter = { execute: async () => ({ success: false, error: 'denied', errorCode: 'HTTP_TARGET_DENIED', durationMs: 1, reversible: false, redacted: true }) };
    const tools = new ToolService(adapter);
    const approvalId = `denied-${Date.now()}`;
    await tools.execute({ name: 'execute_http', arguments: { url: 'http://127.0.0.1' } }, { source: 'agent', approvalId, conversationId: 'conversation-test' });
    expect(await prisma.changeRecord.findFirst({ where: { entityType: 'execution', entityId: approvalId } })).toBeNull();
  });
});
