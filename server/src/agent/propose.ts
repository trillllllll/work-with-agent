import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import { DomainError } from '../domain/task.js';
import { canonical, inspectCommands, normalizeCommands, runSerializedCommand, type Command } from '../application/commands.js';
import { commandFor, validateLibraryArguments } from '../application/agent-library.js';
import { commandsFor, targetTopicId, validateMemoryArguments } from '../application/agent-memory.js';
import { internalActor, ownerActor } from '../application/security.js';
import { now, type Db } from '../application/workspace-store.js';
import { taskCreateSchema, taskUpdateSchema, parseInput } from '../application/workspace-input.js';
import { prisma } from '../infrastructure/prisma.js';
import { proposeChangesInput, type ChangeOperation } from './capabilities.js';
import { parseWorkspaceCommand } from './workspace-commands.js';
import { appendRunEvent } from './events.js';
import { buildReview, previewHashOf } from './review.js';
import { codePoints } from './text.js';

function fail(error: unknown): never {
  if (error instanceof DomainError) throw error;
  if (error instanceof ZodError) throw new DomainError('INVALID_TOOL_ARGUMENTS', error.issues.map((issue) => issue.message).join('；'), 400);
  throw error;
}

function mergeWorkspace(operations: ChangeOperation[]) {
  const merged = new Map<string, { index: number; input: Record<string, unknown>; expectedRevision?: number; clientRef?: string; kind: string; targetId?: string }>();
  const ordered: Array<{ kind: string; targetId?: string; expectedRevision?: number; clientRef?: string; input: Record<string, unknown> }> = [];
  operations.forEach((operation) => {
    if (operation.family !== 'workspace') return;
    const command = operation.command;
    if (command.kind !== 'task.update' || !command.targetId) {
      ordered.push({ kind: command.kind, targetId: command.targetId, expectedRevision: command.expectedRevision, clientRef: command.clientRef, input: { ...command.input } });
      return;
    }
    const existing = merged.get(command.targetId);
    if (!existing) {
      const copy = { index: ordered.length, kind: command.kind, targetId: command.targetId, expectedRevision: command.expectedRevision, clientRef: command.clientRef, input: { ...command.input } };
      merged.set(command.targetId, copy);
      ordered.push(copy);
      return;
    }
    if (existing.expectedRevision !== command.expectedRevision) throw new DomainError('CONFLICTING_PATCH', '同一任务的版本不一致，不能合成一份修改', 400);
    for (const [key, value] of Object.entries(command.input)) {
      if (key in existing.input && canonical(existing.input[key]) !== canonical(value)) throw new DomainError('CONFLICTING_PATCH', `同一任务的${key}给出了不同目标值`, 400);
      existing.input[key] = value;
    }
  });
  return ordered;
}

function validateWorkspace(command: { kind: string; targetId?: string; expectedRevision?: number; clientRef?: string; input: Record<string, unknown> }) {
  return parseWorkspaceCommand(command);
}

async function orderTaskParentMoves(commands: Command[], db: Db): Promise<Command[]> {
  const taskIndexes = commands.flatMap((command, index) => command.kind === 'task.create' || command.kind === 'task.update' ? [index] : []);
  if (taskIndexes.length < 2) return commands;
  const ids = commands.flatMap((command) => command.targetId && command.kind.startsWith('task.') ? [command.targetId] : []);
  const rows = ids.length ? await db.task.findMany({ where: { OR: [{ id: { in: ids } }, { parentId: { in: ids } }] }, select: { id: true, parentId: true, title: true } }) : [];
  const finalParent = new Map(rows.map((row) => [row.id, row.parentId]));
  for (const command of commands) {
    if (command.kind === 'task.create' && command.entityId) finalParent.set(command.entityId, typeof command.input.parentId === 'string' ? command.input.parentId : null);
    if (command.kind === 'task.update' && command.targetId && Object.prototype.hasOwnProperty.call(command.input, 'parentId')) finalParent.set(command.targetId, typeof command.input.parentId === 'string' ? command.input.parentId : null);
  }
  const indexByTarget = new Map(commands.flatMap((command, index) => command.kind === 'task.update' && command.targetId ? [[command.targetId, index] as const] : []));
  const deps = new Map(taskIndexes.map((index) => [index, new Set<number>()]));
  for (const command of commands) {
    const parentId = typeof command.input.parentId === 'string' ? command.input.parentId : '';
    const self = commands.indexOf(command);
    const createIndex = parentId ? commands.findIndex((item) => item.kind === 'task.create' && item.entityId === parentId) : -1;
    if (createIndex >= 0 && deps.has(self)) deps.get(self)?.add(createIndex);
    if (command.kind !== 'task.update' || !command.targetId || !finalParent.get(command.targetId)) continue;
    const children = rows.filter((row) => row.parentId === command.targetId);
    for (const child of children) {
      const moveIndex = indexByTarget.get(child.id);
      if (moveIndex === undefined || finalParent.get(child.id) === command.targetId) {
        const names = children.filter((item) => finalParent.get(item.id) === command.targetId).map((item) => item.title || item.id);
        throw new DomainError('INVALID_PARENT', `还有子任务没有移出：${names.join('、') || child.title || child.id}`, 400);
      }
      deps.get(indexByTarget.get(command.targetId)!)?.add(moveIndex);
    }
  }
  const pending = new Set(taskIndexes);
  const ordered: Command[] = [];
  while (pending.size) {
    const ready = [...pending].filter((index) => [...(deps.get(index) ?? [])].every((item) => !pending.has(item))).sort((left, right) => left - right);
    if (!ready.length) throw new DomainError('INVALID_PARENT', '移动顺序存在循环', 400);
    const next = ready[0]!;
    pending.delete(next);
    ordered.push(commands[next]!);
  }
  let cursor = 0;
  const slots = new Set(taskIndexes);
  return commands.map((command, index) => slots.has(index) ? ordered[cursor++]! : command);
}

export async function compileChangeOperations(operations: ChangeOperation[], context: { conversationId: string; topicId: string | null }, db: Db = prisma) {
  const workspace = mergeWorkspace(operations).map((command) => validateWorkspace(command));
  const commands: Command[] = workspace.map((command) => ({ kind: command.kind, ...(command.targetId ? { targetId: command.targetId } : {}), ...(command.expectedRevision ? { expectedRevision: command.expectedRevision } : {}), ...(command.clientRef ? { clientRef: command.clientRef } : {}), input: command.input }));
  let excerpt = 0;
  for (const operation of operations) {
    if (operation.family === 'library') {
      const invalid = validateLibraryArguments(operation.args);
      if (invalid) throw new DomainError('INVALID_TOOL_ARGUMENTS', invalid, 400);
      const command = commandFor(operation.args.action as never, operation.args);
      if (operation.clientRef) command.clientRef = operation.clientRef;
      commands.push(command);
    }
    if (operation.family === 'memory') {
      const invalid = validateMemoryArguments(operation.args);
      if (invalid) throw new DomainError('INVALID_TOOL_ARGUMENTS', invalid, 400);
      excerpt += 1;
      const topicId = targetTopicId(operation.args.target, context.topicId);
      const compiled = await commandsFor(operation.args.action as 'add' | 'replace' | 'remove', operation.args, topicId, { conversationId: context.conversationId }, `chat-source-${excerpt}`, db);
      commands.push(...compiled);
    }
  }
  if (commands.length > 50) throw new DomainError('INVALID_BATCH', '编译后的修改超过 50 项', 400);
  const normalized = await orderTaskParentMoves(normalizeCommands(commands).map((command) => {
    if (command.kind === 'task.create') return { ...command, input: parseInput(taskCreateSchema, command.input) };
    if (command.kind === 'task.update') return { ...command, input: parseInput(taskUpdateSchema, command.input) };
    return command;
  }), db);
  for (const command of normalized) {
    if (command.kind !== 'task.reorder') continue;
    const topicId = typeof command.input.topicId === 'string' ? command.input.topicId : null;
    const parentId = typeof command.input.parentId === 'string' ? command.input.parentId : null;
    const members = await db.task.findMany({ where: { topicId, parentId, deletedAt: null }, select: { id: true, revision: true } });
    command.input = { ...command.input, expectedRevisions: Object.fromEntries(members.map((row) => [row.id, row.revision])) };
  }
  const explicitIds = normalized.flatMap((command) => [command.targetId, command.entityId].filter((id): id is string => Boolean(id)));
  const taskIds = normalized.filter((command) => command.kind.startsWith('task.') && command.targetId).map((command) => command.targetId!);
  const baseTaskRevisions: Record<string, number> = {};
  if (taskIds.length) {
    const rows = await db.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, revision: true } });
    for (const row of rows) baseTaskRevisions[row.id] = row.revision;
    if (rows.length !== new Set(taskIds).size) throw new DomainError('NOT_FOUND', '要修改的任务不存在', 404);
  }
  const batch = Object.keys(baseTaskRevisions).length ? { revisionMode: 'batch-base-v1' as const, baseTaskRevisions } : undefined;
  return { commands: normalized, explicitIds, batch };
}

function readReferencedApproval(contextJson: string) {
  try {
    const parsed = JSON.parse(contextJson) as { referencedApprovalId?: unknown };
    return typeof parsed.referencedApprovalId === 'string' ? parsed.referencedApprovalId : '';
  } catch { return ''; }
}

async function ownsRun(tx: Db, runId: string, leaseToken: string) {
  const run = await tx.agentRun.findUnique({ where: { id: runId } });
  const timestamp = new Date().toISOString();
  if (!run || run.leaseToken !== leaseToken || !run.leaseExpiresAt || run.leaseExpiresAt <= timestamp) throw new DomainError('LEASE_LOST', '这次请求已经失去执行权', 409);
  const conversation = await tx.conversation.findUnique({ where: { id: run.conversationId }, select: { activeRunId: true } });
  if (conversation?.activeRunId !== run.id) throw new DomainError('RUN_SUPERSEDED', '已有更新的请求，这次修改不会提交', 409);
  if (run.state !== 'running') throw new DomainError('RUN_NOT_RUNNING', '请求不在执行中', 409);
  return run;
}

export async function prepareChanges(input: {
  runId: string;
  leaseToken: string;
  conversationId: string;
  assistantMessageId: string;
  sourceUserMessageId: string;
  toolCallId: string;
  topicId: string | null;
  args: unknown;
}) {
  let parsed;
  try { parsed = proposeChangesInput.parse(input.args); }
  catch (error) { fail(error); }
  if (codePoints(parsed!.summary) < 1 || codePoints(parsed!.summary) > 200) throw new DomainError('INVALID_TOOL_ARGUMENTS', 'summary 需要 1～200 个字符', 400);
  let compiled;
  try { compiled = await compileChangeOperations(parsed!.operations, { conversationId: input.conversationId, topicId: input.topicId }); }
  catch (error) { fail(error); }
  const requestId = `builtin-proposal:${input.runId}:${input.assistantMessageId}:${input.toolCallId}`;
  const requestHash = createHash('sha256').update(canonical(parsed)).digest('hex');
  const prepared = await runSerializedCommand(async (tx) => {
    const run = await ownsRun(tx, input.runId, input.leaseToken);
    const existing = await tx.requestReceipt.findUnique({ where: { actorId_requestId: { actorId: internalActor.id, requestId } } });
    if (existing) {
      if (existing.requestHash !== requestHash) throw new DomainError('IDEMPOTENCY_CONFLICT', '相同请求标识不能提交不同内容');
      return JSON.parse(existing.response) as { approvalId: string; proposalId: string; replayed: true };
    }
    const auditRecords: import('@prisma/client').ChangeRecord[] = [];
    const inspections = await inspectCommands(tx, ownerActor, compiled!.commands, compiled!.batch, auditRecords, internalActor);
    const reviewWithoutHash = buildReview({ intent: parsed!.summary, requestedOperationCount: parsed!.operations.length, commandCount: compiled!.commands.length, explicitIds: compiled!.explicitIds, records: auditRecords });
    if (!reviewWithoutHash.entities.length) return { approvalId: null as string | null, proposalId: null as string | null, code: 'NO_CHANGES' as const };
    const preconditions = { revisionMode: compiled!.batch?.revisionMode ?? null, baseTaskRevisions: compiled!.batch?.baseTaskRevisions ?? {}, inspections: inspections.map((item) => item.preconditions), actor: ownerActor, initiator: internalActor, audit: { conversationId: input.conversationId } };
    const previewHash = previewHashOf(compiled!.commands, preconditions, reviewWithoutHash);
    const review = { ...reviewWithoutHash, previewHash };
    const referencedApprovalId = readReferencedApproval(run.contextJson);
    let supersedesApprovalId = parsed!.supersedesApprovalId;
    if (referencedApprovalId) {
      const referenced = await tx.approval.findUnique({ where: { id: referencedApprovalId } });
      if (!referenced || referenced.conversationId !== input.conversationId) throw new DomainError('INVALID_REFERENCE', '这份方案不属于当前会话', 400);
      if (referenced.status === 'pending') {
        if (supersedesApprovalId && supersedesApprovalId !== referencedApprovalId) throw new DomainError('INVALID_BATCH', '只能替换正在调整的方案', 400);
        supersedesApprovalId = referencedApprovalId;
      }
    }
    let superseded: { approvalId: string; proposalId: string; envelope: Record<string, unknown> } | undefined;
    if (supersedesApprovalId) {
      const old = await tx.approval.findUnique({ where: { id: supersedesApprovalId } });
      const envelope = old?.result ? JSON.parse(old.result) as Record<string, unknown> : null;
      if (!old || old.conversationId !== input.conversationId || old.status !== 'pending' || !envelope) throw new DomainError('INVALID_BATCH', '只能替换同一会话里待确认的方案', 400);
      const proposalId = typeof envelope.proposalId === 'string' ? envelope.proposalId : '';
      const proposal = proposalId ? await tx.proposal.findUnique({ where: { id: proposalId } }) : null;
      if (!proposal || proposal.status !== 'pending') throw new DomainError('APPROVAL_ALREADY_HANDLED', '该审核已处理');
      superseded = { approvalId: old.id, proposalId, envelope };
    }
    const timestamp = now();
    const proposal = await tx.proposal.create({ data: { actorId: internalActor.id, commands: JSON.stringify(compiled!.commands), preconditions: JSON.stringify(preconditions), preview: JSON.stringify(review), createdAt: timestamp, updatedAt: timestamp } });
    const envelope = {
      schemaVersion: 2, kind: 'app_changes', runId: run.id, proposalId: proposal.id, proposalRevision: proposal.revision,
      assistantMessageId: input.assistantMessageId, sourceUserMessageId: input.sourceUserMessageId, toolCallId: input.toolCallId,
      requestedOperations: parsed!.operations, review, outcome: null, supersededByApprovalId: null, reversesApprovalId: null,
    };
    const approval = await tx.approval.create({ data: { conversationId: input.conversationId, toolName: 'propose_changes', arguments: JSON.stringify({ ...parsed, ...(supersedesApprovalId ? { supersedesApprovalId } : {}) }), result: JSON.stringify(envelope), runId: run.id, createdAt: timestamp, updatedAt: timestamp } });
    if (superseded) {
      const closed = await tx.proposal.updateMany({ where: { id: superseded.proposalId, status: 'pending' }, data: { status: 'rejected', revision: { increment: 1 }, updatedAt: timestamp } });
      if (!closed.count) throw new DomainError('APPROVAL_ALREADY_HANDLED', '该审核已处理');
      const next = { ...superseded.envelope, supersededByApprovalId: approval.id, outcome: { status: 'rejected', appliedOperationCount: 0, code: 'APPROVAL_SUPERSEDED', message: '已由新方案替代', completedAt: timestamp } };
      const marked = await tx.approval.updateMany({ where: { id: superseded.approvalId, status: 'pending' }, data: { status: 'rejected', result: JSON.stringify(next), updatedAt: timestamp } });
      if (!marked.count) throw new DomainError('APPROVAL_ALREADY_HANDLED', '该审核已处理');
    }
    const response = { approvalId: approval.id, proposalId: proposal.id, proposalRevision: proposal.revision, previewHash, replayed: false };
    await tx.requestReceipt.create({ data: { actorId: internalActor.id, requestId, requestHash, response: JSON.stringify(response), createdAt: timestamp } });
    await appendRunEvent(tx, run.id, 'approval_required', {
      type: 'approval_required', conversationId: input.conversationId, messageId: input.assistantMessageId, toolCallId: input.toolCallId,
      toolName: 'propose_changes', approvalId: approval.id, proposalId: proposal.id, proposalRevision: proposal.revision, previewHash, review,
      ...(supersedesApprovalId ? { supersedesApprovalId } : {}),
    });
    await tx.agentRun.update({ where: { id: run.id }, data: { state: 'waiting_approval', leaseToken: null, leaseExpiresAt: null, updatedAt: timestamp } });
    return response;
  });
  if ('code' in prepared && prepared.code === 'NO_CHANGES') return { success: false as const, code: 'NO_CHANGES', error: '这些修改不会改变任何业务数据，因此没有生成待确认方案。' };
  return { success: true as const, data: { status: 'pending', approvalId: prepared.approvalId, proposalId: prepared.proposalId, message: '已生成待确认方案，业务数据尚未修改。' } };
}
