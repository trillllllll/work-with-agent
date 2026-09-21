import { Approval as ApprovalDomain, type ApprovalState } from '../domain/approval.js';
import { prisma } from '../infrastructure/prisma.js';
import type { ToolCall, MutationContext } from './workspace.js';
import { randomUUID } from 'node:crypto';
import { CommandService, type Command } from './commands.js';
import { internalActor } from './security.js';

export type ApprovalStatus = ApprovalState;
export type ApprovalResult = { success: boolean; data?: unknown; error?: string };
const now = () => new Date().toISOString();

export class ApprovalService {
  private async prepare(call: ToolCall, audit: Pick<MutationContext, 'conversationId' | 'approvalId'> = {}, allowLegacyRefresh = false) {
    let result: string | undefined;
    if (!call.name.startsWith('execute_')) {
      const args = { ...call.arguments };
      const targetId = typeof args.taskId === 'string' ? args.taskId : typeof args.topicId === 'string' && !call.name.startsWith('create_') ? args.topicId : undefined;
      delete args.taskId;
      if (!call.name.includes('task')) delete args.topicId;
      let kind = call.name;
      if (kind === 'propose_topic_summary') { kind = 'topic.update'; args.draftSummary = args.summary; delete args.summary; }
      const command: Command = { kind, targetId, input: args };
      if (targetId) {
        const row = !allowLegacyRefresh ? null : call.name.includes('task') ? await prisma.task.findUnique({ where: { id: targetId } }) : await prisma.topic.findUnique({ where: { id: targetId } });
        command.expectedRevision = typeof args.expectedRevision === 'number' ? args.expectedRevision : row?.revision;
        delete args.expectedRevision;
      }
      const proposal = await new CommandService().submit(internalActor, { requestId: `builtin:${randomUUID()}`, commands: [command] }, { audit });
      result = JSON.stringify({ proposalId: proposal.proposalId, proposalRevision: proposal.proposalRevision });
    }
    return result;
  }
  async create(call: ToolCall, conversationId?: string) {
    const timestamp = now();
    const id = randomUUID();
    const result = await this.prepare(call, { conversationId, approvalId: id });
    return prisma.approval.create({ data: { id, toolName: call.name, arguments: JSON.stringify(call.arguments), conversationId, result, createdAt: timestamp, updatedAt: timestamp } });
  }
  async preview(approvalId: string) {
    const row = await this.get(approvalId);
    if (!row || row.status !== 'pending') throw Object.assign(new Error('审核不存在或已处理'), { status: 409 });
    if (row.toolName.startsWith('execute_')) throw Object.assign(new Error('受控执行使用原审核流程'), { status: 400 });
    let link = row.result ? JSON.parse(row.result) : null;
    if (!link?.proposalId) {
      const result = await this.prepare(this.parse(row), { conversationId: row.conversationId ?? undefined, approvalId: row.id }, true);
      await prisma.approval.update({ where: { id: row.id }, data: { result, updatedAt: now() } });
      link = JSON.parse(result!);
    }
    const proposal = await new CommandService().get(internalActor, link.proposalId);
    return { approvalId, ...link, preview: proposal.preview };
  }
  async get(approvalId: string) { return prisma.approval.findUnique({ where: { id: approvalId } }); }
  async list(status?: ApprovalStatus) { return prisma.approval.findMany({ where: status ? { status } : undefined, orderBy: { createdAt: 'asc' } }); }
  async update(approvalId: string, status: ApprovalStatus, result?: ApprovalResult) { return prisma.$transaction(async (tx) => { const current = await tx.approval.findUnique({ where: { id: approvalId } }); if (!current) throw Object.assign(new Error('审核记录不存在'), { status: 404 }); const approval = ApprovalDomain.restore({ id: current.id, status: current.status as ApprovalStatus }); if (status === 'rejected') approval.reject(); else if (status === 'executed') approval.executed(); else if (status === 'failed') approval.failed(); else if (status === 'approved') approval.approve(); return tx.approval.update({ where: { id: approvalId }, data: { status: approval.status, result: result ? JSON.stringify(result) : undefined, updatedAt: now() } }); }); }
  async claim(approvalId: string) { const claimed = await prisma.approval.updateMany({ where: { id: approvalId, status: 'pending' }, data: { status: 'approved', updatedAt: now() } }); return claimed.count === 1; }
  parse(value: { toolName: string; arguments: string }): ToolCall { return { name: value.toolName, arguments: JSON.parse(value.arguments) as Record<string, unknown> }; }
}
