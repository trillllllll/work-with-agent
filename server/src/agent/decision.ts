import { createHash, randomUUID } from 'node:crypto';
import type { Approval, AgentRun } from '@prisma/client';
import { DomainError } from '../domain/task.js';
import { canonical, executeCommands, inspectCommands, runSerializedCommand, type Command } from '../application/commands.js';
import { internalActor, ownerActor } from '../application/security.js';
import { now, type Db } from '../application/workspace-store.js';
import { prisma } from '../infrastructure/prisma.js';
import type { ModelMessage } from '../agent.js';
import { appendRunEvent } from './events.js';
import { builtinToolMessageId } from './ids.js';
import { compileChangeOperations } from './propose.js';
import { buildReview, previewHashOf, type ApprovalReview } from './review.js';

const REMOVED = '此能力已移出内置 AI';

export type DecisionInput = { expectedProposalRevision?: number; previewHash?: string };

type Envelope = {
  schemaVersion: 2;
  kind: 'app_changes';
  runId: string;
  proposalId: string;
  proposalRevision: number;
  assistantMessageId: string;
  sourceUserMessageId: string;
  toolCallId: string;
  requestedOperations: unknown[];
  review: ApprovalReview;
  outcome: null | { status: 'executed'; appliedOperationCount: number; changeId: string | null; affected: Array<{ type: string; id: string; title: string }>; completedAt: string } | { status: 'rejected' | 'failed'; appliedOperationCount: 0; code: string; message: string; completedAt: string };
  supersededByApprovalId: string | null;
  reversesApprovalId: string | null;
};

export function readEnvelope(result: string | null): Envelope | null {
  if (!result) return null;
  try {
    const parsed = JSON.parse(result) as Envelope;
    if (parsed?.schemaVersion === 2 && parsed.kind === 'app_changes' && parsed.review?.previewHash) return parsed;
    return null;
  } catch { return null; }
}

function toolMessageId(envelope: Envelope) {
  return builtinToolMessageId(envelope.runId, envelope.assistantMessageId, envelope.toolCallId);
}

function receiptId(approvalId: string, revision: number, action: string) {
  return `builtin-decision:${approvalId}:${revision}:${action}`;
}

async function writeToolMessage(tx: Db, approval: Approval, envelope: Envelope, result: unknown) {
  const id = toolMessageId(envelope);
  const content = JSON.stringify({ toolName: approval.toolName, toolCallId: envelope.toolCallId, assistantMessageId: envelope.assistantMessageId, ...(result as object) });
  const existing = await tx.message.findUnique({ where: { id } });
  if (existing) await tx.message.update({ where: { id }, data: { content, status: 'completed' } });
  else if (approval.conversationId) {
    await tx.message.create({ data: { id, conversationId: approval.conversationId, role: 'tool', content, status: 'completed', toolCallId: envelope.toolCallId, createdAt: now() } });
  }
  if (envelope.runId) {
    const run = await tx.agentRun.findUnique({ where: { id: envelope.runId } });
    if (run) {
      const messages = JSON.parse(run.modelMessagesJson) as ModelMessage[];
      const tool = { role: 'tool' as const, tool_call_id: envelope.toolCallId, content };
      const index = messages.findIndex((message) => message.role === 'tool' && message.tool_call_id === envelope.toolCallId);
      if (index >= 0) messages[index] = tool;
      else messages.push(tool);
      await tx.agentRun.update({ where: { id: run.id }, data: { modelMessagesJson: JSON.stringify(messages), updatedAt: now() } });
    }
  }
}

function affectedOf(review: ApprovalReview) {
  return review.entities.map((entity) => ({ type: entity.entityType, id: entity.entityId, title: entity.titleAfter ?? entity.titleBefore ?? entity.entityId }));
}

export async function approveAppChanges(approvalId: string, input: DecisionInput) {
  if (input.expectedProposalRevision === undefined || !input.previewHash) throw new DomainError('REVIEW_REQUIRED', '请刷新页面后确认这份预览', 409);
  const loaded = await prisma.approval.findUnique({ where: { id: approvalId } });
  if (!loaded) throw Object.assign(new Error('审核记录不存在'), { status: 404 });
  if (loaded.toolName.startsWith('execute_')) throw new DomainError('CAPABILITY_REMOVED', REMOVED, 409);
  const envelope = readEnvelope(loaded.result);
  if (!envelope) throw new DomainError('REVIEW_REQUIRED', '无法读取这份历史方案，请重新生成预览', 409);
  if (envelope.review.previewHash !== input.previewHash) throw new DomainError('REVIEW_REQUIRED', '预览已变化，请重新确认', 409);
  const requestId = receiptId(approvalId, input.expectedProposalRevision, 'approve');
  const requestHash = createHash('sha256').update(canonical({ approvalId, revision: input.expectedProposalRevision, previewHash: input.previewHash, action: 'approve' })).digest('hex');
  const claimed = await runSerializedCommand(async (tx) => {
    const receipt = await tx.requestReceipt.findUnique({ where: { actorId_requestId: { actorId: ownerActor.id, requestId } } });
    if (receipt) {
      if (receipt.requestHash !== requestHash) throw new DomainError('IDEMPOTENCY_CONFLICT', '相同请求标识不能提交不同内容');
      return { done: true as const, body: JSON.parse(receipt.response) };
    }
    const approval = await tx.approval.findUnique({ where: { id: approvalId } });
    const current = approval ? readEnvelope(approval.result) : null;
    if (!approval || !current) throw new DomainError('REVIEW_REQUIRED', '无法读取这份方案', 409);
    if (approval.status === 'approved' && approval.decisionToken && approval.decisionExpiresAt && approval.decisionExpiresAt > now()) return { done: true as const, body: { inProgress: true, approvalId } };
    if (approval.status !== 'pending' || current.proposalRevision !== input.expectedProposalRevision) throw new DomainError('APPROVAL_ALREADY_HANDLED', '该审核已处理', 409);
    const token = randomUUID();
    const marked = await tx.approval.updateMany({ where: { id: approvalId, status: 'pending' }, data: { status: 'approved', decisionToken: token, decisionExpiresAt: new Date(Date.now() + 60_000).toISOString(), updatedAt: now() } });
    if (!marked.count) throw new DomainError('APPROVAL_ALREADY_HANDLED', '该审核已处理', 409);
    return { done: false as const, token };
  });
  if (claimed.done) return claimed.body;
  try {
    return await executeDecision(approvalId, claimed.token, requestId, requestHash);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return persistFailure(approvalId, requestId, requestHash, error);
  }
}

async function executeDecision(approvalId: string, token: string, requestId: string, requestHash: string) {
  const result = await runSerializedCommand(async (tx) => {
    const receipt = await tx.requestReceipt.findUnique({ where: { actorId_requestId: { actorId: ownerActor.id, requestId } } });
    if (receipt) return JSON.parse(receipt.response);
    const approval = await tx.approval.findUnique({ where: { id: approvalId } });
    if (!approval || approval.decisionToken !== token || !approval.decisionExpiresAt || approval.decisionExpiresAt <= now()) throw new DomainError('DECISION_IN_PROGRESS', '正在核对上一次确认', 409);
    const envelope = readEnvelope(approval.result);
    if (!envelope) throw new DomainError('REVIEW_REQUIRED', '无法读取这份方案', 409);
    const proposal = await tx.proposal.findUnique({ where: { id: envelope.proposalId } });
    if (!proposal || proposal.status !== 'pending' || proposal.revision !== envelope.proposalRevision) throw new DomainError('VERSION_CONFLICT', '内容已变化，本次未修改');
    const stored = JSON.parse(proposal.preconditions) as { baseTaskRevisions?: Record<string, number>; inspections: unknown[] };
    const commands = JSON.parse(proposal.commands) as Command[];
    const batch = stored.baseTaskRevisions && Object.keys(stored.baseTaskRevisions).length ? { revisionMode: 'batch-base-v1' as const, baseTaskRevisions: stored.baseTaskRevisions } : undefined;
    const inspected = await inspectCommands(tx, ownerActor, commands, batch);
    if (canonical(inspected.map((item) => item.preconditions)) !== canonical(stored.inspections)) throw new DomainError('VERSION_CONFLICT', '内容已变化，本次未修改');
    const applied = await executeCommands(tx, ownerActor, commands, proposal.id, { conversationId: approval.conversationId ?? undefined, approvalId: approval.id }, batch, { source: 'agent', actor: internalActor, approvedByActorId: ownerActor.id });
    const timestamp = now();
    const outcome = { status: 'executed' as const, appliedOperationCount: commands.length, changeId: applied.changeId ?? null, affected: affectedOf(envelope.review), completedAt: timestamp };
    const next = { ...envelope, outcome };
    await tx.proposal.update({ where: { id: proposal.id }, data: { status: 'executed', revision: { increment: 1 }, result: JSON.stringify(outcome), updatedAt: timestamp } });
    await tx.approval.update({ where: { id: approval.id }, data: { status: 'executed', result: JSON.stringify(next), decisionToken: null, decisionExpiresAt: null, updatedAt: timestamp } });
    const toolResult = { success: true, data: outcome };
    await writeToolMessage(tx, approval, envelope, toolResult);
    let resumed = false;
    if (envelope.runId && approval.conversationId) {
      const [run, conversation] = await Promise.all([tx.agentRun.findUnique({ where: { id: envelope.runId } }), tx.conversation.findUnique({ where: { id: approval.conversationId } })]);
      if (run && conversation?.activeRunId === run.id && run.state === 'waiting_approval') {
        const cursor = JSON.parse(run.cursorJson) as { schemaVersion: 1; phase: string; round: number; budgetEndRound: number; assistantMessageId: string | null; nextToolIndex: number };
        await tx.agentRun.update({ where: { id: run.id }, data: { state: 'queued', pauseReason: null, cursorJson: JSON.stringify({ ...cursor, phase: 'model', round: cursor.round + 1, nextToolIndex: 0 }), updatedAt: timestamp } });
        resumed = true;
      }
    }
    await appendRunEvent(tx, envelope.runId, 'approval_resolved', { type: 'approval_resolved', approvalId, status: 'executed', changeId: outcome.changeId });
    const body = { approvalId, outcome, resumed };
    await tx.requestReceipt.create({ data: { actorId: ownerActor.id, requestId, requestHash, response: JSON.stringify(body), createdAt: timestamp } });
    return body;
  });
  return result;
}

async function persistFailure(approvalId: string, requestId: string, requestHash: string, error: DomainError) {
  return runSerializedCommand(async (tx) => {
    const receipt = await tx.requestReceipt.findUnique({ where: { actorId_requestId: { actorId: ownerActor.id, requestId } } });
    if (receipt) return JSON.parse(receipt.response);
    const approval = await tx.approval.findUnique({ where: { id: approvalId } });
    const envelope = approval ? readEnvelope(approval.result) : null;
    if (!approval || !envelope) throw error;
    const timestamp = now();
    const outcome = { status: 'failed' as const, appliedOperationCount: 0 as const, code: error.code, message: error.code === 'VERSION_CONFLICT' ? '内容已变化，本次未修改' : error.message, completedAt: timestamp };
    await tx.approval.update({ where: { id: approval.id }, data: { status: 'failed', result: JSON.stringify({ ...envelope, outcome }), decisionToken: null, decisionExpiresAt: null, updatedAt: timestamp } });
    if (envelope.proposalId) await tx.proposal.updateMany({ where: { id: envelope.proposalId, status: 'pending' }, data: { status: 'failed', updatedAt: timestamp } });
    await writeToolMessage(tx, approval, envelope, { success: false, code: outcome.code, error: outcome.message });
    if (envelope.runId) {
      const run = await tx.agentRun.findUnique({ where: { id: envelope.runId } });
      const conversation = approval.conversationId ? await tx.conversation.findUnique({ where: { id: approval.conversationId } }) : null;
      if (run && conversation?.activeRunId === run.id && run.state === 'waiting_approval') {
        await tx.agentRun.update({ where: { id: run.id }, data: { state: 'paused', pauseReason: 'conflict', leaseToken: null, leaseExpiresAt: null, updatedAt: timestamp } });
        await appendRunEvent(tx, run.id, 'run_state', { type: 'run_state', runId: run.id, state: 'paused', pauseReason: 'conflict' });
      }
    }
    const body = { approvalId, outcome, resumed: false };
    await tx.requestReceipt.create({ data: { actorId: ownerActor.id, requestId, requestHash, response: JSON.stringify(body), createdAt: timestamp } });
    return body;
  });
}

export async function rejectAppChanges(approvalId: string, input: DecisionInput) {
  if (input.expectedProposalRevision === undefined || !input.previewHash) throw new DomainError('REVIEW_REQUIRED', '请刷新页面后确认这份预览', 409);
  const requestId = receiptId(approvalId, input.expectedProposalRevision, 'reject');
  const requestHash = createHash('sha256').update(canonical({ approvalId, revision: input.expectedProposalRevision, previewHash: input.previewHash, action: 'reject' })).digest('hex');
  return runSerializedCommand(async (tx) => {
    const receipt = await tx.requestReceipt.findUnique({ where: { actorId_requestId: { actorId: ownerActor.id, requestId } } });
    if (receipt) {
      if (receipt.requestHash !== requestHash) throw new DomainError('IDEMPOTENCY_CONFLICT', '相同请求标识不能提交不同内容');
      return JSON.parse(receipt.response);
    }
    const approval = await tx.approval.findUnique({ where: { id: approvalId } });
    if (!approval) throw Object.assign(new Error('审核记录不存在'), { status: 404 });
    if (approval.toolName.startsWith('execute_')) throw new DomainError('CAPABILITY_REMOVED', REMOVED, 409);
    const envelope = readEnvelope(approval.result);
    if (!envelope) throw new DomainError('REVIEW_REQUIRED', '无法读取这份历史方案，请重新生成预览', 409);
    if (envelope.review.previewHash !== input.previewHash || envelope.proposalRevision !== input.expectedProposalRevision) throw new DomainError('REVIEW_REQUIRED', '预览已变化，请重新确认', 409);
    if (approval.status !== 'pending') throw new DomainError('APPROVAL_ALREADY_HANDLED', '该审核已处理', 409);
    const timestamp = now();
    const outcome = { status: 'rejected' as const, appliedOperationCount: 0 as const, code: 'REJECTED', message: '已取消，未修改数据', completedAt: timestamp };
    const marked = await tx.approval.updateMany({ where: { id: approvalId, status: 'pending' }, data: { status: 'rejected', result: JSON.stringify({ ...envelope, outcome }), updatedAt: timestamp } });
    if (!marked.count) throw new DomainError('APPROVAL_ALREADY_HANDLED', '该审核已处理', 409);
    await tx.proposal.updateMany({ where: { id: envelope.proposalId, status: 'pending' }, data: { status: 'rejected', updatedAt: timestamp } });
    await writeToolMessage(tx, approval, envelope, { success: false, code: 'REJECTED', error: outcome.message });
    if (envelope.runId && approval.conversationId) {
      const run = await tx.agentRun.findUnique({ where: { id: envelope.runId } });
      const conversation = await tx.conversation.findUnique({ where: { id: approval.conversationId } });
      if (run && conversation?.activeRunId === run.id && run.state === 'waiting_approval') {
        await tx.agentRun.update({ where: { id: run.id }, data: { state: 'paused', pauseReason: 'rejected', leaseToken: null, leaseExpiresAt: null, updatedAt: timestamp } });
        await appendRunEvent(tx, run.id, 'run_state', { type: 'run_state', runId: run.id, state: 'paused', pauseReason: 'rejected' });
      }
    }
    const body = { approvalId, outcome, resumed: false };
    await tx.requestReceipt.create({ data: { actorId: ownerActor.id, requestId, requestHash, response: JSON.stringify(body), createdAt: timestamp } });
    return body;
  });
}

export async function repreviewApproval(approvalId: string) {
  const approval = await prisma.approval.findUnique({ where: { id: approvalId } });
  if (!approval) throw Object.assign(new Error('审核记录不存在'), { status: 404 });
  const envelope = readEnvelope(approval.result);
  if (!envelope) throw new DomainError('REVIEW_REQUIRED', '无法读取这份历史方案，请重新生成预览', 409);
  if (!approval.conversationId || !envelope.runId) throw new DomainError('REVIEW_REQUIRED', '这份方案不能重新预览', 409);
  const operations = envelope.requestedOperations as import('./capabilities.js').ChangeOperation[];
  for (const operation of operations) {
    if (operation.family !== 'workspace' || !operation.command.targetId) continue;
    const task = await prisma.task.findUnique({ where: { id: operation.command.targetId }, select: { revision: true } });
    if (task && operation.command.kind.startsWith('task.')) operation.command.expectedRevision = task.revision;
    const topic = operation.command.kind.startsWith('topic.') ? await prisma.topic.findUnique({ where: { id: operation.command.targetId }, select: { revision: true } }) : null;
    if (topic) operation.command.expectedRevision = topic.revision;
  }
  const run = await prisma.agentRun.findUnique({ where: { id: envelope.runId } });
  if (!run) throw new DomainError('NOT_FOUND', '原请求不存在', 404);
  const compiled = await compileChangeOperations(operations, { conversationId: approval.conversationId, topicId: null });
  return runSerializedCommand(async (tx) => {
    const auditRecords: import('@prisma/client').ChangeRecord[] = [];
    const inspections = await inspectCommands(tx, ownerActor, compiled.commands, compiled.batch, auditRecords, internalActor);
    const reviewWithoutHash = buildReview({ intent: envelope.review.intent, requestedOperationCount: operations.length, commandCount: compiled.commands.length, explicitIds: compiled.explicitIds, records: auditRecords });
    if (!reviewWithoutHash.entities.length) throw new DomainError('NO_CHANGES', '按原来的修改重新计算后，没有需要确认的变化', 409);
    const preconditions = { revisionMode: compiled.batch?.revisionMode ?? null, baseTaskRevisions: compiled.batch?.baseTaskRevisions ?? {}, inspections: inspections.map((item) => item.preconditions), actor: ownerActor, initiator: internalActor, audit: { conversationId: approval.conversationId } };
    const previewHash = previewHashOf(compiled.commands, preconditions, reviewWithoutHash);
    const review = { ...reviewWithoutHash, previewHash };
    const timestamp = now();
    const proposal = await tx.proposal.create({ data: { actorId: internalActor.id, commands: JSON.stringify(compiled.commands), preconditions: JSON.stringify(preconditions), preview: JSON.stringify(review), createdAt: timestamp, updatedAt: timestamp } });
    const nextEnvelope = { ...envelope, proposalId: proposal.id, proposalRevision: proposal.revision, review, outcome: null, supersededByApprovalId: null, requestedOperations: operations };
    const created = await tx.approval.create({ data: { conversationId: approval.conversationId, toolName: 'propose_changes', arguments: approval.arguments, result: JSON.stringify(nextEnvelope), runId: envelope.runId, createdAt: timestamp, updatedAt: timestamp } });
    const previous = readEnvelope(approval.result) ?? envelope;
    await tx.approval.update({ where: { id: approval.id }, data: { result: JSON.stringify({ ...previous, supersededByApprovalId: created.id }), updatedAt: timestamp } });
    if (approval.status === 'pending') {
      await tx.approval.updateMany({ where: { id: approval.id, status: 'pending' }, data: { status: 'rejected', updatedAt: timestamp } });
      await tx.proposal.updateMany({ where: { id: envelope.proposalId, status: 'pending' }, data: { status: 'rejected', updatedAt: timestamp } });
    }
    const conversation = approval.conversationId ? await tx.conversation.findUnique({ where: { id: approval.conversationId } }) : null;
    if (conversation?.activeRunId === envelope.runId) {
      await tx.agentRun.updateMany({ where: { id: envelope.runId, state: { in: ['paused', 'waiting_approval'] } }, data: { state: 'waiting_approval', pauseReason: null, leaseToken: null, leaseExpiresAt: null, updatedAt: timestamp } });
    }
    return { approvalId: created.id, previewHash, supersedesApprovalId: approval.id };
  });
}

export async function undoPreview(approvalId: string) {
  const approval = await prisma.approval.findUnique({ where: { id: approvalId } });
  const envelope = approval ? readEnvelope(approval.result) : null;
  if (!approval || !envelope?.outcome || envelope.outcome.status !== 'executed' || !envelope.outcome.changeId) throw new DomainError('CHANGE_NOT_REVERSIBLE', '这份修改不能撤销', 400);
  const changeId = envelope.outcome.changeId;
  return runSerializedCommand(async (tx) => {
    const record = await tx.changeRecord.findUnique({ where: { id: changeId } });
    if (!record || record.undoneAt) throw new DomainError('CHANGE_NOT_REVERSIBLE', '该变更不可撤销', 400);
    const command: Command = { kind: 'change.undo', targetId: changeId, input: {} };
    const auditRecords: import('@prisma/client').ChangeRecord[] = [];
    const inspections = await inspectCommands(tx, ownerActor, [command], undefined, auditRecords, internalActor);
    const reviewWithoutHash = buildReview({ intent: '撤销刚才的修改', requestedOperationCount: 1, commandCount: 1, explicitIds: [changeId], records: auditRecords });
    const preconditions = { inspections: inspections.map((item) => item.preconditions), actor: ownerActor, initiator: internalActor, undoOf: approval.id };
    const previewHash = previewHashOf([command], preconditions, reviewWithoutHash);
    const review = { ...reviewWithoutHash, previewHash, title: '撤销修改' };
    const timestamp = now();
    const proposal = await tx.proposal.create({ data: { actorId: internalActor.id, commands: JSON.stringify([command]), preconditions: JSON.stringify(preconditions), preview: JSON.stringify(review), createdAt: timestamp, updatedAt: timestamp } });
    const next = {
      schemaVersion: 2, kind: 'app_changes', runId: envelope.runId, proposalId: proposal.id, proposalRevision: proposal.revision,
      assistantMessageId: envelope.assistantMessageId, sourceUserMessageId: envelope.sourceUserMessageId, toolCallId: `${envelope.toolCallId}:undo`,
      requestedOperations: [{ family: 'workspace', command: { kind: 'task.update', input: {} } }], review, outcome: null, supersededByApprovalId: null, reversesApprovalId: approval.id,
    };
    const created = await tx.approval.create({ data: { conversationId: approval.conversationId, toolName: 'propose_changes', arguments: JSON.stringify({ undoOf: approval.id }), result: JSON.stringify(next), runId: envelope.runId, createdAt: timestamp, updatedAt: timestamp } });
    return { approvalId: created.id, previewHash, reversesApprovalId: approval.id };
  });
}

export async function recoverExpiredDecisions() {
  const timestamp = now();
  const rows = await prisma.approval.findMany({ where: { status: 'approved', decisionExpiresAt: { lt: timestamp } } });
  for (const row of rows) {
    const revision = readEnvelope(row.result)?.proposalRevision;
    if (!revision) continue;
    const requestId = receiptId(row.id, revision, 'approve');
    await runSerializedCommand(async (tx) => {
      const fresh = await tx.approval.findUnique({ where: { id: row.id } });
      if (!fresh || fresh.status !== 'approved') return;
      const receipt = await tx.requestReceipt.findUnique({ where: { actorId_requestId: { actorId: ownerActor.id, requestId } } });
      if (receipt) {
        const body = JSON.parse(receipt.response) as { outcome?: { status?: string } };
        await tx.approval.update({ where: { id: fresh.id }, data: { status: body.outcome?.status === 'executed' ? 'executed' : 'failed', decisionToken: null, decisionExpiresAt: null, updatedAt: now() } });
        return;
      }
      if (fresh.decisionToken && fresh.decisionExpiresAt && fresh.decisionExpiresAt > now()) return;
      await tx.approval.updateMany({ where: { id: fresh.id, status: 'approved' }, data: { status: 'pending', decisionToken: null, decisionExpiresAt: null, updatedAt: now() } });
    });
  }
}

export function continuationNeeded(run: AgentRun | null) {
  return Boolean(run && run.state === 'queued');
}
