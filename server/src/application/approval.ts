import { Approval as ApprovalDomain, type ApprovalState } from '../domain/approval.js';
import { prisma } from '../infrastructure/prisma.js';
import type { ToolCall } from './workspace.js';

export type ApprovalStatus = ApprovalState;
export type ApprovalResult = { success: boolean; data?: unknown; error?: string };
const now = () => new Date().toISOString();

export class ApprovalService {
  async create(call: ToolCall, conversationId?: string) { const timestamp = now(); return prisma.approval.create({ data: { toolName: call.name, arguments: JSON.stringify(call.arguments), conversationId, createdAt: timestamp, updatedAt: timestamp } }); }
  async get(approvalId: string) { return prisma.approval.findUnique({ where: { id: approvalId } }); }
  async list(status?: ApprovalStatus) { return prisma.approval.findMany({ where: status ? { status } : undefined, orderBy: { createdAt: 'asc' } }); }
  async update(approvalId: string, status: ApprovalStatus, result?: ApprovalResult) { return prisma.$transaction(async (tx) => { const current = await tx.approval.findUnique({ where: { id: approvalId } }); if (!current) throw Object.assign(new Error('审核记录不存在'), { status: 404 }); const approval = ApprovalDomain.restore({ id: current.id, status: current.status as ApprovalStatus }); if (status === 'rejected') approval.reject(); else if (status === 'executed') approval.executed(); else if (status === 'failed') approval.failed(); else if (status === 'approved') approval.approve(); return tx.approval.update({ where: { id: approvalId }, data: { status: approval.status, result: result ? JSON.stringify(result) : undefined, updatedAt: now() } }); }); }
  async claim(approvalId: string) { const claimed = await prisma.approval.updateMany({ where: { id: approvalId, status: 'pending' }, data: { status: 'approved', updatedAt: now() } }); return claimed.count === 1; }
  parse(value: { toolName: string; arguments: string }): ToolCall { return { name: value.toolName, arguments: JSON.parse(value.arguments) as Record<string, unknown> }; }
}
