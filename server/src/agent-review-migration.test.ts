import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import request, { ownerSession } from './test-auth.js';
import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import { AgentService, type ModelMessage } from './agent.js';
import type { ToolCall } from './application/workspace.js';
import { readStoredApproval } from './domain/task-batch-types.js';

const api = request(app);
const now = () => new Date().toISOString();

async function approval(data: { toolName: string; arguments: string; result: string | null; status?: 'pending' | 'executed' | 'rejected' }) {
  return prisma.approval.create({ data: { toolName: data.toolName, arguments: data.arguments, result: data.result, status: data.status ?? 'pending', createdAt: now(), updatedAt: now() } });
}

describe('historical approval compatibility', () => {
  it('keeps old batch and result rows readable, and blocks removed execution plus hashless approval', async () => {
    const batch = await approval({
      toolName: 'propose_task_changes',
      arguments: '{}',
      result: JSON.stringify({ schemaVersion: 1, kind: 'task_batch', toolCallId: 'old-batch', preview: { summary: '历史整组', operations: [] } }),
    });
    const legacy = await approval({ toolName: 'library', arguments: '{}', result: JSON.stringify({ success: true, data: { recorded: true } }), status: 'executed' });
    const removed = await approval({ toolName: 'execute_file', arguments: JSON.stringify({ operation: 'read', path: 'package.json' }), result: null });
    expect(readStoredApproval(batch.result).resultState).toBe('batch');
    expect(readStoredApproval(legacy.result).resultState).toBe('result');
    const batchView = await api.get(`/api/agent/approvals/${batch.id}`);
    const legacyView = await api.get(`/api/agent/approvals/${legacy.id}`);
    const removedView = await api.get(`/api/agent/approvals/${removed.id}`);
    expect(batchView.status, JSON.stringify(batchView.body)).toBe(200);
    expect(batchView.body.data.approval.toolName).toBe('propose_task_changes');
    expect(legacyView.status).toBe(200);
    expect(legacyView.body.data.approval.status).toBe('executed');
    expect(removedView.body.data.approval.capabilityRemoved).toBe(true);

    const session = await ownerSession(app);
    const blocked = await supertest(app).post(`/api/agent/approvals/${removed.id}/approve`).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('CAPABILITY_REMOVED');
    const rejected = await supertest(app).post(`/api/agent/approvals/${removed.id}/reject`).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({});
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: removed.id } })).status).toBe('rejected');

    const task = await api.post('/api/tasks').send({ title: `旧接口不能绕过-${Date.now()}` });
    expect(task.status, JSON.stringify(task.body)).toBe(200);
    const agent = new AgentService({
      stream: async function* (messages: ModelMessage[]) {
        if (messages.some((message) => message.role === 'tool')) { yield { text: '方案还在。' }; return; }
        const call: ToolCall = { id: 'call_hash', name: 'propose_changes', arguments: { summary: '改一个字', operations: [{ family: 'workspace', command: { kind: 'task.update', targetId: task.body.data.id, expectedRevision: task.body.data.revision, input: { title: '不该绕过' } } }] } };
        yield { toolCalls: [call] };
      },
    } as never);
    const chat = await agent.chat({ message: '请生成需要预览哈希的方案', pageContext: { page: 'inbox' } });
    const pending = chat.events.find((event) => event.type === 'approval_required');
    expect(pending?.approvalId).toBeTruthy();
    const missing = await supertest(app).post(`/api/agent/approvals/${pending!.approvalId}/approve`).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({});
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe('REVIEW_REQUIRED');
    const bypass = await supertest(app).post(`/api/v1/proposals/${pending!.proposalId}/approve`).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ expectedRevision: pending!.proposalRevision, requestId: `bypass-${Date.now()}` });
    expect(bypass.status).toBe(409);
    expect(bypass.body.code).toBe('REVIEW_REQUIRED');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.body.data.id } })).title).toBe(task.body.data.title);
  });
});
