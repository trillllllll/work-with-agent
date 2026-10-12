import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../domain/task.js';
import {
  BATCH_REJECT_TEXT,
  BATCH_SUPERSEDE_TEXT,
  applyPageTopic,
  batchFailureText,
  batchSuccessText,
  buildTaskBatchPreview,
  compileTaskBatch,
  parseProposeTaskChanges,
  toTaskSnapshot,
  type CompiledCommand,
  type ProposeTaskChangesArgs,
} from '../domain/task-batch.js';
import { readStoredApproval, type BatchFailure, type BatchOutcome, type TaskBatchPreview, type TaskSnapshot } from '../domain/task-batch-types.js';
import { prisma } from '../infrastructure/prisma.js';
import {
  canonical,
  commandDigest,
  executeCommands,
  inspectCommands,
  normalizeCommands,
  publishWorkspaceChange,
  runSerializedCommand,
  type Command,
} from './commands.js';
import { internalActor, ownerActor } from './security.js';
import { type Db, now } from './workspace-store.js';

export type BatchChatResponse = { result: BatchOutcome; assistantMessage: string; assistantMessageId: string };

const approvalKey = (approvalId: string) => `approval:${approvalId}`;
export function batchToolMessageId(conversationId: string, assistantMessageId: string, toolCallId: string) {
  return `batch-tool-${createHash('sha256').update(`${conversationId}\0${assistantMessageId}\0${toolCallId}`).digest('hex')}`;
}
export function batchSummaryMessageId(approvalId: string) {
  return `batch-summary-${createHash('sha256').update(approvalId).digest('hex')}`;
}

function snapshotsOf(rows: Array<Parameters<typeof toTaskSnapshot>[0]>) {
  return rows.map((row) => toTaskSnapshot(row)).sort((left, right) => left.id.localeCompare(right.id));
}

async function readSnapshots(tx: Db, where: { OR: Array<{ topicId: string | null }> } | { id: { in: string[] } }) {
  return snapshotsOf(await tx.task.findMany({ where, include: { tags: true } }));
}

function explicitIds(commands: CompiledCommand[]) {
  return commands.flatMap((command) => command.entityId ? [command.entityId] : command.targetId ? [command.targetId] : []);
}

function affectedIds(commands: CompiledCommand[], inspections: Array<{ preconditions: unknown; preview: unknown }>, before: TaskSnapshot[], after: TaskSnapshot[]) {
  const ids = new Set<string>(explicitIds(commands));
  for (const command of commands) if (typeof command.input.parentId === 'string') ids.add(command.input.parentId);
  for (const inspection of inspections) {
    const stored = inspection.preconditions as { command?: { rows?: unknown[] } };
    for (const entry of stored.command?.rows ?? []) {
      const key = Array.isArray(entry) ? entry[0] : undefined;
      if (typeof key === 'string' && key.startsWith('task:')) ids.add(key.slice('task:'.length));
    }
    const preview = inspection.preview as { detail?: { affectedTasks?: Array<{ id?: string }> }; after?: { meta?: { affectedTaskIds?: string[] } } };
    for (const task of preview.detail?.affectedTasks ?? []) if (task?.id) ids.add(task.id);
    for (const id of preview.after?.meta?.affectedTaskIds ?? []) if (typeof id === 'string') ids.add(id);
  }
  const expand = (tasks: TaskSnapshot[]) => {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    let grew = true;
    while (grew) {
      grew = false;
      for (const id of [...ids]) {
        const parentId = byId.get(id)?.parentId;
        if (parentId && byId.has(parentId) && !ids.has(parentId)) { ids.add(parentId); grew = true; }
      }
    }
  };
  expand(before);
  expand(after);
  return ids;
}

async function upsertMessage(tx: Db, id: string, data: { conversationId: string; role: 'tool' | 'assistant'; content: string; toolCallId?: string }) {
  const timestamp = now();
  await tx.message.upsert({
    where: { id },
    create: { id, conversationId: data.conversationId, role: data.role, content: data.content, status: 'completed', toolCallId: data.toolCallId ?? null, createdAt: timestamp },
    update: { content: data.content, status: 'completed', toolCallId: data.toolCallId ?? null },
  });
}

function toolContent(link: { toolCallId: string; assistantMessageId: string }, outcome: BatchOutcome | { success: false; error: string; code: string }) {
  return JSON.stringify({ toolName: 'propose_task_changes', toolCallId: link.toolCallId, assistantMessageId: link.assistantMessageId, ...outcome });
}

async function writeClose(tx: Db, link: { conversationId: string; toolCallId: string; assistantMessageId: string }, approvalId: string, outcome: BatchOutcome, assistantMessage: string) {
  await upsertMessage(tx, batchToolMessageId(link.conversationId, link.assistantMessageId, link.toolCallId), { conversationId: link.conversationId, role: 'tool', content: toolContent(link, outcome), toolCallId: link.toolCallId });
  const assistantMessageId = batchSummaryMessageId(approvalId);
  await upsertMessage(tx, assistantMessageId, { conversationId: link.conversationId, role: 'assistant', content: assistantMessage });
  return assistantMessageId;
}

async function storedResponse(tx: Db, approvalId: string, outcome: BatchOutcome): Promise<BatchChatResponse> {
  const assistantMessageId = batchSummaryMessageId(approvalId);
  const message = await tx.message.findUnique({ where: { id: assistantMessageId } });
  return { result: outcome, assistantMessage: message?.content ?? '', assistantMessageId };
}

async function approvalReceipt(tx: Db, approvalId: string) {
  return tx.requestReceipt.findUnique({ where: { actorId_requestId: { actorId: ownerActor.id, requestId: approvalKey(approvalId) } } });
}

function failureOutcome(proposalId: string, error: DomainError): BatchFailure {
  return { success: false, error: error.message, code: error.code, data: { proposalId, atomic: true, appliedOperationCount: 0 } };
}

export async function taskBatchCommitError(value: unknown, pageContext?: { topicId?: string | null }): Promise<DomainError | null> {
  try {
    const filled = applyPageTopic(parseProposeTaskChanges(value), pageContext);
    const mentioned = new Set<string>();
    for (const operation of filled.operations) {
      if (operation.kind === 'task.update') mentioned.add(operation.targetId);
      if (typeof operation.input.parentId === 'string') mentioned.add(operation.input.parentId);
    }
    const ids = [...mentioned];
    const graphRows = ids.length ? await prisma.task.findMany({ where: { OR: [{ id: { in: ids } }, { parentId: { in: ids } }] }, select: { id: true, revision: true, title: true, topicId: true, parentId: true, deletedAt: true } }) : [];
    compileTaskBatch(filled, graphRows, (commands) => normalizeCommands(commands as unknown as Command[]) as unknown as Array<CompiledCommand & { sourceIndex?: number }>);
    return null;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
}

export async function prepareTaskBatch(input: {
  conversationId: string;
  assistantMessageId: string;
  sourceUserMessageId: string;
  toolCallId: string;
  arguments: ProposeTaskChangesArgs;
  pageContext?: { topicId?: string | null };
}): Promise<{ approvalId: string; proposalId: string; preview: TaskBatchPreview }> {
  const filled = applyPageTopic(parseProposeTaskChanges(input.arguments), input.pageContext);
  const requestHash = commandDigest(filled);
  const requestId = `chat-batch:${input.conversationId}:${input.assistantMessageId}:${input.toolCallId}`;
  const prepared = await runSerializedCommand(async (tx) => {
    const [user, assistant] = await Promise.all([tx.message.findUnique({ where: { id: input.sourceUserMessageId } }), tx.message.findUnique({ where: { id: input.assistantMessageId } })]);
    if (!user || user.conversationId !== input.conversationId || user.role !== 'user' || !assistant || assistant.conversationId !== input.conversationId || assistant.role !== 'assistant') {
      throw new DomainError('INVALID_BATCH', '整组提议必须属于当前会话的用户消息和助手消息', 400);
    }
    const calls = JSON.parse(assistant.toolCalls || '[]') as Array<{ id?: string; function?: { name?: string } }>;
    if (!calls.some((call) => call.id === input.toolCallId && call.function?.name === 'propose_task_changes')) throw new DomainError('INVALID_BATCH', '助手消息里没有这次整组提议', 400);
    const existing = await tx.requestReceipt.findUnique({ where: { actorId_requestId: { actorId: internalActor.id, requestId } } });
    if (existing) {
      if (existing.requestHash !== requestHash) throw new DomainError('IDEMPOTENCY_CONFLICT', '相同请求标识不能提交不同内容');
      return JSON.parse(existing.response) as { approvalId: string; proposalId: string; preview: TaskBatchPreview };
    }
    let superseded: { approvalId: string; proposalId: string; envelope: Record<string, unknown> } | undefined;
    if (filled.supersedesApprovalId) {
      const oldApproval = await tx.approval.findUnique({ where: { id: filled.supersedesApprovalId } });
      const oldRead = readStoredApproval(oldApproval?.result);
      if (!oldApproval || oldApproval.conversationId !== input.conversationId || oldRead.resultState !== 'batch' || !oldRead.proposalId) throw new DomainError('INVALID_BATCH', '只能替换同一会话里待确认的整组提议', 400);
      if (oldApproval.status !== 'pending') throw new DomainError('APPROVAL_ALREADY_HANDLED', '该审核已处理');
      const oldProposal = await tx.proposal.findUnique({ where: { id: oldRead.proposalId } });
      if (!oldProposal || oldProposal.status !== 'pending') throw new DomainError('APPROVAL_ALREADY_HANDLED', '该审核已处理');
      superseded = { approvalId: oldApproval.id, proposalId: oldProposal.id, envelope: JSON.parse(oldApproval.result!) as Record<string, unknown> };
    }
    const mentioned = new Set<string>();
    for (const operation of filled.operations) {
      if (operation.kind === 'task.update') mentioned.add(operation.targetId);
      if (typeof operation.input.parentId === 'string') mentioned.add(operation.input.parentId);
    }
    const ids = [...mentioned];
    const graphRows = ids.length ? await tx.task.findMany({ where: { OR: [{ id: { in: ids } }, { parentId: { in: ids } }] }, select: { id: true, revision: true, title: true, topicId: true, parentId: true, deletedAt: true } }) : [];
    const compiled = compileTaskBatch(filled, graphRows, (commands) => normalizeCommands(commands as unknown as Command[]) as unknown as Array<CompiledCommand & { sourceIndex?: number }>);
    const topics = new Set<string | null>(graphRows.map((row) => row.topicId));
    for (const command of compiled.commands) if (command.kind === 'task.create' && (typeof command.input.topicId === 'string' || command.input.topicId === null)) topics.add(command.input.topicId as string | null);
    const topicList = [...topics];
    const before = topicList.length ? await readSnapshots(tx, { OR: topicList.map((topicId) => ({ topicId })) }) : [];
    let after: TaskSnapshot[] = [];
    const inspections = await inspectCommands(tx, internalActor, compiled.commands as Command[], {
      revisionMode: 'batch-base-v1',
      baseTaskRevisions: compiled.baseTaskRevisions,
      onPreview: async (inner) => { after = topicList.length ? await readSnapshots(inner, { OR: topicList.map((topicId) => ({ topicId })) }) : []; },
    });
    const affected = affectedIds(compiled.commands, inspections, before, after);
    const preview = buildTaskBatchPreview({ summary: compiled.summary, operationCount: compiled.commands.length, before: before.filter((task) => affected.has(task.id)), after: after.filter((task) => affected.has(task.id)), explicitIds: explicitIds(compiled.commands) });
    const approvalId = randomUUID();
    const timestamp = now();
    const proposal = await tx.proposal.create({ data: {
      actorId: internalActor.id,
      commands: JSON.stringify(compiled.commands),
      preconditions: JSON.stringify({ actor: internalActor, audit: { conversationId: input.conversationId, approvalId }, inspections: inspections.map((item) => item.preconditions), revisionMode: 'batch-base-v1', baseTaskRevisions: compiled.baseTaskRevisions, chatBatch: { approvalId, conversationId: input.conversationId, toolCallId: input.toolCallId, assistantMessageId: input.assistantMessageId, sourceUserMessageId: input.sourceUserMessageId } }),
      preview: JSON.stringify(preview),
      createdAt: timestamp,
      updatedAt: timestamp,
    } });
    const envelope = { schemaVersion: 1, kind: 'task_batch', proposalId: proposal.id, proposalRevision: proposal.revision, toolCallId: input.toolCallId, assistantMessageId: input.assistantMessageId, sourceUserMessageId: input.sourceUserMessageId, summary: compiled.summary, preview };
    await tx.approval.create({ data: { id: approvalId, conversationId: input.conversationId, toolName: 'propose_task_changes', arguments: JSON.stringify(filled), result: JSON.stringify(envelope), createdAt: timestamp, updatedAt: timestamp } });
    const response = { approvalId, proposalId: proposal.id, preview };
    await tx.requestReceipt.create({ data: { actorId: internalActor.id, requestId, requestHash, response: JSON.stringify(response), createdAt: timestamp } });
    if (superseded) {
      const closed = await tx.proposal.updateMany({ where: { id: superseded.proposalId, status: 'pending' }, data: { status: 'rejected', revision: { increment: 1 }, updatedAt: timestamp } });
      if (!closed.count) throw new DomainError('APPROVAL_ALREADY_HANDLED', '该审核已处理');
      const outcome: BatchFailure = { success: false, error: BATCH_SUPERSEDE_TEXT, code: 'APPROVAL_SUPERSEDED', data: { proposalId: superseded.proposalId, atomic: true, appliedOperationCount: 0 } };
      const next = { ...superseded.envelope, supersededByApprovalId: approvalId, outcome };
      const marked = await tx.approval.updateMany({ where: { id: superseded.approvalId, status: 'pending' }, data: { status: 'rejected', result: JSON.stringify(next), updatedAt: timestamp } });
      if (!marked.count) throw new DomainError('APPROVAL_ALREADY_HANDLED', '该审核已处理');
      const link = { conversationId: input.conversationId, toolCallId: String(superseded.envelope.toolCallId), assistantMessageId: String(superseded.envelope.assistantMessageId) };
      await writeClose(tx, link, superseded.approvalId, outcome, BATCH_SUPERSEDE_TEXT);
    }
    return response;
  });
  publishWorkspaceChange({ kind: 'pending_approval', proposalId: prepared.proposalId, approvalId: prepared.approvalId });
  return prepared;
}

async function applyTaskBatch(tx: Db, approvalId: string): Promise<BatchChatResponse> {
  const approval = await tx.approval.findUnique({ where: { id: approvalId } });
  if (!approval) throw Object.assign(new Error('审核记录不存在'), { status: 404 });
  const read = readStoredApproval(approval.result);
  if (read.resultState !== 'batch' || !read.proposalId || !read.toolCallId || !read.assistantMessageId) throw new DomainError('INVALID_BATCH', '这不是整组任务修改', 400);
  const receipt = await approvalReceipt(tx, approvalId);
  if (receipt) return JSON.parse(receipt.response) as BatchChatResponse;
  if (approval.status !== 'pending') {
    if (read.outcome) return storedResponse(tx, approvalId, read.outcome);
    throw Object.assign(new Error('该审核已处理'), { status: 409 });
  }
  const proposal = await tx.proposal.findUnique({ where: { id: read.proposalId } });
  if (!proposal || proposal.status !== 'pending') throw new DomainError('APPROVAL_ALREADY_HANDLED', '该审核已处理');
  const stored = JSON.parse(proposal.preconditions) as { actor: typeof internalActor; audit?: { conversationId?: string; approvalId?: string }; inspections: unknown; revisionMode?: string; baseTaskRevisions?: Record<string, number> };
  if (stored.revisionMode !== 'batch-base-v1' || !stored.baseTaskRevisions) throw new DomainError('INVALID_BATCH', '整组提议缺少起点版本', 400);
  const commands = JSON.parse(proposal.commands) as Command[];
  const inspected = await inspectCommands(tx, internalActor, commands, { revisionMode: 'batch-base-v1', baseTaskRevisions: stored.baseTaskRevisions });
  if (canonical(inspected.map((item) => item.preconditions)) !== canonical(stored.inspections)) throw new DomainError('VERSION_CONFLICT', '任务已变化，请重新生成预览。');
  const applied = await executeCommands(tx, internalActor, commands, proposal.id, { conversationId: approval.conversationId ?? undefined, approvalId }, { revisionMode: 'batch-base-v1', baseTaskRevisions: stored.baseTaskRevisions });
  const ids = new Set<string>([...applied.meta.affectedTaskIds, ...explicitIds(commands)]);
  let tasks = await readSnapshots(tx, { id: { in: [...ids] } });
  const parents = tasks.flatMap((task) => task.parentId ? [task.parentId] : []).filter((id) => !ids.has(id));
  if (parents.length) tasks = snapshotsOf([...tasks, ...await readSnapshots(tx, { id: { in: parents } })]);
  const preview = read.preview ?? JSON.parse(proposal.preview) as TaskBatchPreview;
  const outcome: BatchOutcome = { success: true, data: { proposalId: proposal.id, changeId: applied.changeId ?? '', operationCount: commands.length, affectedTaskIds: [...ids].sort((left, right) => left.localeCompare(right)), tasks } };
  const assistantMessage = batchSuccessText(preview, tasks);
  const timestamp = now();
  const envelope = { ...(JSON.parse(approval.result!) as Record<string, unknown>), proposalRevision: proposal.revision + 1, outcome };
  await tx.proposal.update({ where: { id: proposal.id }, data: { status: 'executed', revision: { increment: 1 }, result: JSON.stringify({ status: 'applied', proposalId: proposal.id, ...applied }), updatedAt: timestamp } });
  await tx.approval.update({ where: { id: approval.id }, data: { status: 'executed', result: JSON.stringify(envelope), updatedAt: timestamp } });
  const assistantMessageId = await writeClose(tx, { conversationId: approval.conversationId ?? '', toolCallId: read.toolCallId, assistantMessageId: read.assistantMessageId }, approval.id, outcome, assistantMessage);
  const response = { result: outcome, assistantMessage, assistantMessageId };
  await tx.requestReceipt.create({ data: { actorId: ownerActor.id, requestId: approvalKey(approval.id), requestHash: commandDigest({ approvalId: approval.id }), response: JSON.stringify(response), createdAt: timestamp } });
  return response;
}

async function recordTaskBatchFailure(tx: Db, approvalId: string, error: DomainError): Promise<BatchChatResponse> {
  const receipt = await approvalReceipt(tx, approvalId);
  if (receipt) return JSON.parse(receipt.response) as BatchChatResponse;
  const approval = await tx.approval.findUnique({ where: { id: approvalId } });
  if (!approval) throw Object.assign(new Error('审核记录不存在'), { status: 404 });
  const read = readStoredApproval(approval.result);
  if (read.outcome && approval.status !== 'pending') return storedResponse(tx, approvalId, read.outcome);
  if (!read.proposalId || !read.toolCallId || !read.assistantMessageId || !approval.conversationId) throw error;
  const outcome = failureOutcome(read.proposalId, error);
  const assistantMessage = batchFailureText(error.message, error.code);
  const timestamp = now();
  await tx.proposal.updateMany({ where: { id: read.proposalId, status: 'pending' }, data: { status: 'rejected', revision: { increment: 1 }, result: JSON.stringify(outcome), updatedAt: timestamp } });
  if (approval.status === 'pending') {
    const envelope = { ...(JSON.parse(approval.result!) as Record<string, unknown>), outcome };
    await tx.approval.update({ where: { id: approval.id }, data: { status: 'failed', result: JSON.stringify(envelope), updatedAt: timestamp } });
  }
  const assistantMessageId = await writeClose(tx, { conversationId: approval.conversationId, toolCallId: read.toolCallId, assistantMessageId: read.assistantMessageId }, approval.id, outcome, assistantMessage);
  const response = { result: outcome, assistantMessage, assistantMessageId };
  const winner = await approvalReceipt(tx, approvalId);
  if (winner) return JSON.parse(winner.response) as BatchChatResponse;
  await tx.requestReceipt.create({ data: { actorId: ownerActor.id, requestId: approvalKey(approval.id), requestHash: commandDigest({ approvalId: approval.id }), response: JSON.stringify(response), createdAt: timestamp } });
  return response;
}

export async function approveTaskBatch(approvalId: string): Promise<BatchChatResponse> {
  try {
    const response = await runSerializedCommand((tx) => applyTaskBatch(tx, approvalId));
    publishWorkspaceChange({ kind: 'applied', approvalId, proposalId: response.result.success ? response.result.data.proposalId : undefined });
    return response;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    const response = await runSerializedCommand((tx) => recordTaskBatchFailure(tx, approvalId, error));
    publishWorkspaceChange({ kind: 'proposal', approvalId });
    return response;
  }
}

export async function rejectTaskBatch(approvalId: string): Promise<BatchChatResponse> {
  const response = await runSerializedCommand(async (tx) => {
    const approval = await tx.approval.findUnique({ where: { id: approvalId } });
    if (!approval) throw Object.assign(new Error('审核记录不存在'), { status: 404 });
    const read = readStoredApproval(approval.result);
    if (read.resultState !== 'batch' || !read.proposalId || !read.toolCallId || !read.assistantMessageId || !approval.conversationId) throw new DomainError('INVALID_BATCH', '这不是整组任务修改', 400);
    const receipt = await approvalReceipt(tx, approvalId);
    if (receipt) return JSON.parse(receipt.response) as BatchChatResponse;
    if (approval.status !== 'pending') {
      if (read.outcome) return storedResponse(tx, approvalId, read.outcome);
      throw Object.assign(new Error('该审核已处理'), { status: 409 });
    }
    const proposal = await tx.proposal.findUnique({ where: { id: read.proposalId } });
    if (!proposal || proposal.status !== 'pending') throw new DomainError('APPROVAL_ALREADY_HANDLED', '该审核已处理');
    const outcome: BatchFailure = { success: false, error: BATCH_REJECT_TEXT, code: 'USER_REJECTED', data: { proposalId: proposal.id, atomic: true, appliedOperationCount: 0 } };
    const timestamp = now();
    await tx.proposal.update({ where: { id: proposal.id }, data: { status: 'rejected', revision: { increment: 1 }, result: JSON.stringify(outcome), updatedAt: timestamp } });
    const envelope = { ...(JSON.parse(approval.result!) as Record<string, unknown>), outcome };
    await tx.approval.update({ where: { id: approval.id }, data: { status: 'rejected', result: JSON.stringify(envelope), updatedAt: timestamp } });
    const assistantMessageId = await writeClose(tx, { conversationId: approval.conversationId, toolCallId: read.toolCallId, assistantMessageId: read.assistantMessageId }, approval.id, outcome, BATCH_REJECT_TEXT);
    const result = { result: outcome, assistantMessage: BATCH_REJECT_TEXT, assistantMessageId };
    await tx.requestReceipt.create({ data: { actorId: ownerActor.id, requestId: approvalKey(approval.id), requestHash: commandDigest({ approvalId: approval.id }), response: JSON.stringify(result), createdAt: timestamp } });
    return result;
  });
  publishWorkspaceChange({ kind: 'proposal', approvalId });
  return response;
}
