import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChatEvent, ModelMessage, PageContext } from '../agent.js';
import { appendAutoMemoryAssistant, beginAutoMemoryTurn, completeAutoMemoryTurn, failAutoMemoryTurn } from '../application/auto-memory-chat.js';
import { canonical } from '../application/commands.js';
import { ContextService } from '../application/conversation.js';
import { checkKnowledgeScope } from '../application/knowledge.js';
import { ownerActor } from '../application/security.js';
import type { ToolCall } from '../application/workspace.js';
import { DomainError } from '../domain/task.js';
import { prisma } from '../infrastructure/prisma.js';
import { assembleRunMessages } from './assemble.js';
import { executeBuiltinTool, type BuiltinResult } from './builtin-tools.js';
import { contextFromRequest, validateScopeAndResolveIds, type StoredChatContext } from './chat-context.js';
import { recoverExpiredDecisions } from './decision.js';
import { appendRunEvent } from './events.js';
import { builtinToolMessageId } from './ids.js';
import { waitRuns } from './wake.js';
import { TextBatcher } from './text-batcher.js';

const LEASE_MS = 120_000;
const MODEL_TIMEOUT_MS = 90_000;
const MAX_LOOPS = 2;
let clock = () => new Date();
export function setRunClock(fn: (() => Date) | null) { clock = fn ?? (() => new Date()); }
const nowIso = () => clock().toISOString();
const expiry = () => new Date(clock().getTime() + LEASE_MS).toISOString();

export const runCursorSchema = z.object({
  schemaVersion: z.literal(1),
  phase: z.enum(['model', 'tools']),
  round: z.number().int().min(0),
  budgetEndRound: z.number().int().min(0),
  assistantMessageId: z.string().nullable(),
  nextToolIndex: z.number().int().min(0),
});
export type RunCursor = z.infer<typeof runCursorSchema>;

export type ModelStream = (messages: ModelMessage[], signal?: AbortSignal, includeTools?: boolean) => AsyncIterable<{ text?: string; toolCalls?: ToolCall[] }>;

const initialCursor = (): RunCursor => ({ schemaVersion: 1, phase: 'model', round: 0, budgetEndRound: 16, assistantMessageId: null, nextToolIndex: 0 });

let slots = 0;
const pending: Array<{ runId: string; stream: ModelStream; contextService: ContextService }> = [];
const runningIds = new Set<string>();
const deferred = new Map<string, (typeof pending)[number]>();
let ticking = false;
let schedulerStream: ModelStream | null = null;
let schedulerContext: ContextService | null = null;
export function resetRunSchedulerState() { schedulerStream = null; schedulerContext = null; }

function isLeaseLoss(error: unknown) {
  return error instanceof DomainError && (error.code === 'LEASE_LOST' || error.code === 'RUN_SUPERSEDED');
}

function readCursor(raw: string): RunCursor {
  return runCursorSchema.parse(JSON.parse(raw));
}

function readContext(raw: string): StoredChatContext {
  const parsed = JSON.parse(raw) as StoredChatContext;
  const { timeZoneSource, ...rest } = parsed;
  const context = contextFromRequest({ context: rest });
  return { ...context, timeZoneSource: timeZoneSource === 'default' ? 'default' : 'context' };
}

async function recordSettled(runId: string, data: ChatEvent) {
  await prisma.$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({ where: { id: runId } });
    if (!run) return;
    const conversation = await tx.conversation.findUnique({ where: { id: run.conversationId }, select: { activeRunId: true } });
    if (conversation?.activeRunId !== run.id) return;
    if (run.state !== 'running' && run.state !== 'waiting_approval') return;
    if (run.state === 'running' && (!run.leaseToken || !run.leaseExpiresAt || run.leaseExpiresAt <= nowIso())) return;
    await appendRunEvent(tx, runId, data.type, { ...data, conversationId: run.conversationId, runId });
  });
}

async function ownsLease(runId: string, token: string) {
  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!run || run.leaseToken !== token || run.state !== 'running' || !run.leaseExpiresAt || run.leaseExpiresAt <= nowIso()) {
    throw new DomainError('LEASE_LOST', '这次请求已经失去执行权', 409);
  }
  const conversation = await prisma.conversation.findUnique({ where: { id: run.conversationId }, select: { activeRunId: true } });
  if (conversation?.activeRunId !== run.id) throw new DomainError('RUN_SUPERSEDED', '已有更新的请求', 409);
  return run;
}

async function recordEvent(runId: string, token: string, data: ChatEvent) {
  await prisma.$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({ where: { id: runId } });
    if (!run || run.leaseToken !== token || run.state !== 'running' || !run.leaseExpiresAt || run.leaseExpiresAt <= nowIso()) {
      throw new DomainError('LEASE_LOST', '这次请求已经失去执行权', 409);
    }
    await appendRunEvent(tx, runId, data.type, { ...data, conversationId: run.conversationId, runId });
  });
}

async function saveCursor(runId: string, token: string, cursor: RunCursor) {
  const updated = await prisma.agentRun.updateMany({
    where: { id: runId, leaseToken: token, state: 'running' },
    data: { cursorJson: JSON.stringify(cursor), updatedAt: nowIso() },
  });
  if (!updated.count) throw new DomainError('LEASE_LOST', '这次请求已经失去执行权', 409);
}

async function saveMessages(runId: string, token: string, messages: ModelMessage[]) {
  await prisma.$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({ where: { id: runId } });
    if (!run) return;
    const conversation = await tx.conversation.findUnique({ where: { id: run.conversationId }, select: { activeRunId: true } });
    if (conversation?.activeRunId !== run.id) return;
    const owned = run.state === 'running' && run.leaseToken === token && Boolean(run.leaseExpiresAt && run.leaseExpiresAt > nowIso());
    if (!owned && run.state !== 'waiting_approval') return;
    await tx.agentRun.update({ where: { id: runId }, data: { modelMessagesJson: JSON.stringify(messages), updatedAt: nowIso() } });
  });
}

function publicResult(result: BuiltinResult) {
  return {
    success: result.success,
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.code ? { code: result.code } : {}),
  };
}

async function writeToolRow(runId: string, conversationId: string, assistantMessageId: string, toolCallId: string, content: string) {
  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!run) return null;
  const conversation = await prisma.conversation.findUnique({ where: { id: run.conversationId }, select: { activeRunId: true } });
  if (conversation?.activeRunId !== run.id) return null;
  if (run.state === 'running' && (!run.leaseToken || !run.leaseExpiresAt || run.leaseExpiresAt <= nowIso())) return null;
  if (run.state !== 'running' && run.state !== 'waiting_approval') return null;
  const id = builtinToolMessageId(runId, assistantMessageId, toolCallId);
  const existing = await prisma.message.findUnique({ where: { id }, select: { id: true } });
  if (existing) await prisma.message.update({ where: { id }, data: { content, status: 'completed' } });
  else await prisma.message.create({ data: { id, conversationId, role: 'tool', content, status: 'completed', toolCallId, createdAt: nowIso() } });
  return id;
}

export function scheduleRun(runId: string, stream: ModelStream, contextService: ContextService) {
  // Approval can queue a continuation before the previous loop has unwound.
  // Retain its model/context and dispatch after that loop releases its slot.
  if (runningIds.has(runId)) { deferred.set(runId, { runId, stream, contextService }); return; }
  if (pending.some((item) => item.runId === runId)) return;
  pending.push({ runId, stream, contextService });
  void pump();
}

async function pump() {
  while (slots < MAX_LOOPS && pending.length) {
    const job = pending.shift();
    if (!job) return;
    const run = await prisma.agentRun.findUnique({ where: { id: job.runId }, select: { id: true, state: true, conversationId: true } });
    if (!run || run.state !== 'queued') continue;
    const busy = await prisma.agentRun.findFirst({ where: { conversationId: run.conversationId, state: 'running', id: { not: run.id } }, select: { id: true } });
    if (busy) {
      pending.unshift(job);
      return;
    }
    slots += 1;
    runningIds.add(job.runId);
    void runLoop(job.runId, job.stream, job.contextService).finally(() => {
      slots -= 1;
      runningIds.delete(job.runId);
      const next = deferred.get(job.runId);
      deferred.delete(job.runId);
      if (next) scheduleRun(next.runId, next.stream, next.contextService);
      void checkAgentRuns();
    });
  }
}

async function pauseOwned(runId: string, token: string, reason: 'round_limit' | 'interrupted' | 'user_stopped', message: string) {
  await prisma.$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({ where: { id: runId } });
    if (!run || run.leaseToken !== token || run.state !== 'running') return;
    const timestamp = nowIso();
    await tx.agentRun.update({ where: { id: runId }, data: { state: 'paused', pauseReason: reason, leaseToken: null, leaseExpiresAt: null, updatedAt: timestamp } });
    await appendRunEvent(tx, runId, 'run_state', { type: 'run_state', runId, state: 'paused', pauseReason: reason, message, conversationId: run.conversationId });
  });
}

async function failOwned(runId: string, token: string, error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? 'RUN_FAILED') : 'RUN_FAILED';
  const message = error instanceof Error ? error.message : '请求失败';
  const sourceUserMessageId = await prisma.$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({ where: { id: runId } });
    if (!run || run.leaseToken !== token || run.state !== 'running') return null;
    const timestamp = nowIso();
    const cursor = readCursor(run.cursorJson);
    if (cursor.assistantMessageId) await tx.message.updateMany({ where: { id: cursor.assistantMessageId, status: 'streaming' }, data: { status: 'failed' } });
    const executed = await tx.approval.findFirst({ where: { runId, status: 'executed' }, select: { id: true } });
    const visible = executed ? `后续回答未完成。${message}` : message;
    await tx.agentRun.update({ where: { id: runId }, data: { state: 'failed', errorCode: code, errorMessage: visible, leaseToken: null, leaseExpiresAt: null, completedAt: timestamp, updatedAt: timestamp } });
    await tx.conversation.updateMany({ where: { id: run.conversationId, activeRunId: runId }, data: { activeRunId: null, updatedAt: timestamp } });
    await appendRunEvent(tx, runId, 'error', { type: 'error', conversationId: run.conversationId, runId, code, message: visible });
    await appendRunEvent(tx, runId, 'run_state', { type: 'run_state', runId, state: 'failed', pauseReason: null, conversationId: run.conversationId });
    return run.sourceUserMessageId;
  });
  if (sourceUserMessageId) await failAutoMemoryTurn(sourceUserMessageId, nowIso());
}

async function finishOwned(runId: string, token: string) {
  const sourceUserMessageId = await prisma.$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({ where: { id: runId } });
    if (!run || run.leaseToken !== token || run.state !== 'running') return null;
    const timestamp = nowIso();
    await tx.agentRun.update({ where: { id: runId }, data: { state: 'completed', leaseToken: null, leaseExpiresAt: null, completedAt: timestamp, updatedAt: timestamp } });
    await tx.conversation.updateMany({ where: { id: run.conversationId, activeRunId: runId }, data: { activeRunId: null, updatedAt: timestamp } });
    await appendRunEvent(tx, runId, 'run_state', { type: 'run_state', runId, state: 'completed', conversationId: run.conversationId });
    return run.sourceUserMessageId;
  });
  if (sourceUserMessageId) await completeAutoMemoryTurn(sourceUserMessageId, nowIso());
}

async function ensureMessages(runId: string, token: string, contextService: ContextService) {
  const run = await ownsLease(runId, token);
  const stored = JSON.parse(run.modelMessagesJson) as ModelMessage[];
  if (stored.length) return stored;
  const source = await prisma.message.findUnique({ where: { id: run.sourceUserMessageId }, select: { content: true } });
  const messages = await assembleRunMessages({
    runId,
    conversationId: run.conversationId,
    sourceUserMessageId: run.sourceUserMessageId,
    context: readContext(run.contextJson),
    userText: source?.content ?? '',
    contextService,
  });
  await ownsLease(runId, token);
  await saveMessages(runId, token, messages);
  return messages;
}

async function modelTurn(runId: string, token: string, stream: ModelStream, contextService: ContextService) {
  const run = await ownsLease(runId, token);
  const cursor = readCursor(run.cursorJson);
  if (cursor.round >= cursor.budgetEndRound) {
    await pauseOwned(runId, token, 'round_limit', '这一轮处理已到上限。可以继续此请求。');
    return 'paused' as const;
  }
  const messages = await ensureMessages(runId, token, contextService);
  const assistant = await prisma.message.create({ data: { conversationId: run.conversationId, role: 'assistant', content: '', status: 'streaming', createdAt: nowIso() } });
  const nextCursor = { ...cursor, assistantMessageId: assistant.id };
  await saveCursor(runId, token, nextCursor);
  await recordEvent(runId, token, { type: 'message_start', conversationId: run.conversationId, messageId: assistant.id });
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, MODEL_TIMEOUT_MS);
  timer.unref?.();
  let text = '';
  const calls: ToolCall[] = [];
  const batcher = new TextBatcher(
    (delta) => recordEvent(runId, token, { type: 'message_delta', conversationId: run.conversationId, messageId: assistant.id, delta }),
    () => controller.abort(),
  );
  try {
    for await (const chunk of stream(messages, controller.signal, true)) {
      if (chunk.text) {
        text += chunk.text;
        await batcher.add(chunk.text);
      }
      if (chunk.toolCalls) calls.push(...chunk.toolCalls);
    }
    await batcher.finish();
  } catch (error) {
    clearTimeout(timer);
    let failure = error;
    try { await batcher.finish(); } catch (writeError) { failure = writeError; }
    try { await applyExecutorSideEffect(runId, token, assistant.id, { content: text, status: 'failed' }); }
    catch (leaseError) { if (!isLeaseLoss(leaseError)) throw leaseError; }
    if (timedOut) throw Object.assign(new Error('模型请求超时'), { code: 'MODEL_TIMEOUT' });
    throw failure;
  } finally {
    clearTimeout(timer);
  }
  calls.forEach((call, index) => { call.id ??= `call_${cursor.round}_${index}`; });
  await applyExecutorSideEffect(runId, token, assistant.id, { content: text, status: 'completed', toolCalls: calls.length ? JSON.stringify(calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } }))) : null });
  await appendAutoMemoryAssistant(run.sourceUserMessageId, assistant.id);
  await recordEvent(runId, token, { type: 'message_end', conversationId: run.conversationId, messageId: assistant.id });
  const assistantMessage: ModelMessage = {
    role: 'assistant',
    content: text || null,
    ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id ?? '', type: 'function' as const, function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } })) } : {}),
  };
  messages.push(assistantMessage);
  await saveMessages(runId, token, messages);
  if (!calls.length) {
    await finishOwned(runId, token);
    return 'completed' as const;
  }
  await saveCursor(runId, token, { ...nextCursor, phase: 'tools', nextToolIndex: 0 });
  return 'tools' as const;
}

async function toolTurn(runId: string, token: string, contextService: ContextService) {
  const run = await ownsLease(runId, token);
  const cursor = readCursor(run.cursorJson);
  const assistantMessageId = cursor.assistantMessageId;
  if (!assistantMessageId) throw new DomainError('RUN_FAILED', '工具阶段缺少助手消息', 500);
  const assistant = await prisma.message.findUnique({ where: { id: assistantMessageId } });
  if (!assistant || assistant.status !== 'completed' || !assistant.toolCalls) throw new DomainError('RUN_FAILED', '不完整的模型回复不能执行工具', 409);
  const calls = JSON.parse(assistant.toolCalls) as Array<{ id: string; function: { name: string; arguments: string } }>;
  const messages = JSON.parse(run.modelMessagesJson) as ModelMessage[];
  const context = readContext(run.contextJson);
  let sawPropose = false;
  for (let index = cursor.nextToolIndex; index < calls.length; index += 1) {
    const call = calls[index];
    if (!call) continue;
    let args: Record<string, unknown> = {};
    let invalid = false;
    try {
      const parsed = JSON.parse(call.function.arguments || '{}') as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid = true;
      else args = parsed as Record<string, unknown>;
    } catch { invalid = true; }
    await recordEvent(runId, token, { type: 'tool_call', conversationId: run.conversationId, messageId: assistantMessageId, toolCallId: call.id, toolName: call.function.name, arguments: args });
    let result: BuiltinResult;
    if (invalid) result = { success: false, code: 'INVALID_TOOL_ARGUMENTS', error: 'Tool 参数不是有效 JSON' };
    else if (call.function.name === 'propose_changes' && sawPropose) result = { success: false, code: 'INVALID_TOOL_ARGUMENTS', error: '一次回复只能提交一份修改方案' };
    else if (call.function.name === 'propose_changes') {
      sawPropose = true;
      await saveCursor(runId, token, { ...cursor, nextToolIndex: index });
      result = await executeBuiltinTool({ name: call.function.name, args, context, run: { id: runId, leaseToken: token, conversationId: run.conversationId, assistantMessageId, sourceUserMessageId: run.sourceUserMessageId }, toolCallId: call.id });
    } else {
      result = await executeBuiltinTool({ name: call.function.name, args, context, run: { id: runId, leaseToken: token, conversationId: run.conversationId, assistantMessageId, sourceUserMessageId: run.sourceUserMessageId }, toolCallId: call.id });
    }
    const content = JSON.stringify({ toolName: call.function.name, toolCallId: call.id, assistantMessageId, ...publicResult(result) });
    await writeToolRow(runId, run.conversationId, assistantMessageId, call.id, content);
    messages.push({ role: 'tool', tool_call_id: call.id, content });
    await saveMessages(runId, token, messages);
    await recordSettled(runId, { type: 'tool_result', conversationId: run.conversationId, messageId: assistantMessageId, toolCallId: call.id, toolName: call.function.name, arguments: args, result: publicResult(result) });
    if (result.part) await recordSettled(runId, { type: 'external_prompt', conversationId: run.conversationId, messageId: assistantMessageId, toolCallId: call.id, part: result.part });
    if (result.approval) {
      for (let rest = index + 1; rest < calls.length; rest += 1) {
        const later = calls[rest];
        if (!later) continue;
        const skipped = { success: false, code: 'NOT_EXECUTED', error: '已生成待确认方案，这一轮其余调用未执行。' };
        const skippedContent = JSON.stringify({ toolName: later.function.name, toolCallId: later.id, assistantMessageId, ...skipped });
        await writeToolRow(runId, run.conversationId, assistantMessageId, later.id, skippedContent);
        messages.push({ role: 'tool', tool_call_id: later.id, content: skippedContent });
        await recordSettled(runId, { type: 'tool_result', conversationId: run.conversationId, messageId: assistantMessageId, toolCallId: later.id, toolName: later.function.name, result: skipped });
      }
      await saveMessages(runId, token, messages);
      return 'waiting' as const;
    }
    await saveCursor(runId, token, { ...cursor, assistantMessageId, phase: 'tools', nextToolIndex: index + 1 });
  }
  if (sawPropose && calls.filter((call) => call.function.name === 'propose_changes').length > 1) {
    await finishOwned(runId, token);
    return 'completed' as const;
  }
  await saveCursor(runId, token, { ...cursor, phase: 'model', round: cursor.round + 1, nextToolIndex: 0 });
  void contextService;
  return 'model' as const;
}

async function runLoop(runId: string, stream: ModelStream, contextService: ContextService) {
  const token = randomUUID();
  const claimed = await prisma.agentRun.updateMany({
    where: { id: runId, state: 'queued' },
    data: { state: 'running', leaseToken: token, leaseExpiresAt: expiry(), updatedAt: nowIso() },
  });
  if (!claimed.count) return;
  const heartbeat = setInterval(() => {
    void prisma.agentRun.updateMany({ where: { id: runId, leaseToken: token, state: 'running' }, data: { leaseExpiresAt: expiry(), updatedAt: nowIso() } });
  }, 10_000);
  heartbeat.unref?.();
  try {
    await recordEvent(runId, token, { type: 'run_state', runId, state: 'running' });
    let phase: 'model' | 'tools' = readCursor((await ownsLease(runId, token)).cursorJson).phase;
    while (phase) {
      if (phase === 'model') {
        const outcome = await modelTurn(runId, token, stream, contextService);
        if (outcome !== 'tools') return;
        phase = 'tools';
      } else {
        const outcome = await toolTurn(runId, token, contextService);
        if (outcome === 'waiting' || outcome === 'completed') return;
        phase = 'model';
      }
    }
  } catch (error) {
    if (!isLeaseLoss(error)) await failOwned(runId, token, error);
  } finally {
    clearInterval(heartbeat);
  }
}

export async function startChat(input: { conversationId?: string; message: string; pageContext?: PageContext; context?: unknown; requestKey?: string }) {
  const message = input.message.trim();
  if (!message) throw new DomainError('INVALID_MESSAGE', '消息不能为空', 400);
  if (input.requestKey !== undefined && (input.requestKey.trim().length < 1 || input.requestKey.length > 200)) throw new DomainError('INVALID_REQUEST', 'requestKey 无效', 400);
  const requestKey = input.requestKey?.trim() || `ephemeral:${randomUUID()}`;
  let conversationId = input.conversationId;
  if (conversationId) {
    const existingConversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true } });
    if (!existingConversation) throw Object.assign(new Error('会话不存在'), { status: 404 });
  } else {
    const timestamp = nowIso();
    conversationId = (await prisma.conversation.create({ data: { createdAt: timestamp, updatedAt: timestamp } })).id;
  }
  const stored = await validateScopeAndResolveIds(contextFromRequest({ context: input.context, pageContext: input.pageContext }));
  if (stored.referencedApprovalId) {
    if (!input.conversationId) throw new DomainError('INVALID_REFERENCE', '这份方案不属于当前会话', 400);
    const referenced = await prisma.approval.findUnique({ where: { id: stored.referencedApprovalId }, select: { conversationId: true } });
    if (!referenced || referenced.conversationId !== input.conversationId) throw new DomainError('INVALID_REFERENCE', '这份方案不属于当前会话', 400);
  }
  const topicId = stored.scope.kind === 'topic' ? stored.scope.topicId : null;
  await checkKnowledgeScope(prisma, ownerActor, stored.scope.kind === 'all' ? null : topicId);
  const requestHash = createHash('sha256').update(canonical({ message, context: stored })).digest('hex');
  return prisma.$transaction(async (tx) => {
    const existing = await tx.agentRun.findUnique({ where: { requestKey } });
    if (existing) {
      if (existing.requestHash !== requestHash) throw new DomainError('IDEMPOTENCY_CONFLICT', '相同请求标识不能提交不同内容', 409);
      return existing;
    }
    const conversation = await tx.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) throw Object.assign(new Error('会话不存在'), { status: 404 });
    if (conversation.activeRunId) {
      const old = await tx.agentRun.findUnique({ where: { id: conversation.activeRunId } });
      if (old && (old.state === 'queued' || old.state === 'running' || old.state === 'waiting_approval')) {
        const timestamp = nowIso();
        await tx.agentRun.update({ where: { id: old.id }, data: { state: 'paused', pauseReason: 'new_user_message', leaseToken: null, leaseExpiresAt: null, updatedAt: timestamp } });
        await appendRunEvent(tx, old.id, 'run_state', { type: 'run_state', runId: old.id, conversationId, state: 'paused', pauseReason: 'new_user_message', message: '已暂停后续处理' });
      }
    }
    const timestamp = nowIso();
    const user = await tx.message.create({ data: { conversationId, role: 'user', content: message, status: 'completed', createdAt: timestamp } });
    const created = await tx.agentRun.create({
      data: {
        conversationId, sourceUserMessageId: user.id, requestKey, requestHash, state: 'queued',
        contextJson: JSON.stringify(stored), modelMessagesJson: '[]', cursorJson: JSON.stringify(initialCursor()),
        createdAt: timestamp, updatedAt: timestamp,
      },
    });
    await tx.conversation.update({ where: { id: conversationId }, data: { activeRunId: created.id, updatedAt: timestamp } });
    await beginAutoMemoryTurn({ conversationId, userMessageId: user.id, topicId, createdAt: timestamp }, tx);
    return created;
  });
}

export async function *followRun(runId: string): AsyncGenerator<ChatEvent> {
  let after = 0;
  for (;;) {
    const events = await prisma.agentRunEvent.findMany({ where: { runId, seq: { gt: after } }, orderBy: { seq: 'asc' } });
    for (const event of events) {
      after = event.seq;
      const data = JSON.parse(event.dataJson) as ChatEvent;
      yield { ...data, runId, seq: event.seq };
    }
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) throw new DomainError('NOT_FOUND', '请求不存在', 404);
    if (run.state === 'completed' || run.state === 'failed' || run.state === 'cancelled' || run.state === 'paused' || run.state === 'waiting_approval') {
      const remaining = await prisma.agentRunEvent.count({ where: { runId, seq: { gt: after } } });
      if (!remaining) {
        yield { type: 'done', conversationId: run.conversationId, runId };
        return;
      }
      continue;
    }
    await waitRuns(200);
  }
}

export async function resumeRun(runId: string, stream: ModelStream, contextService: ContextService) {
  const run = await prisma.$transaction(async (tx) => {
    const current = await tx.agentRun.findUnique({ where: { id: runId } });
    if (!current) throw new DomainError('NOT_FOUND', '请求不存在', 404);
    if (current.state !== 'paused' || !current.pauseReason || !['new_user_message', 'interrupted', 'round_limit'].includes(current.pauseReason)) {
      throw new DomainError('RUN_NOT_RESUMABLE', '这个请求不能继续', 409);
    }
    const busy = await tx.agentRun.findFirst({ where: { conversationId: current.conversationId, state: { in: ['queued', 'running', 'waiting_approval'] } }, select: { id: true } });
    if (busy) throw new DomainError('RUN_BUSY', '已有请求正在处理', 409);
    const cursor = readCursor(current.cursorJson);
    const next = current.pauseReason === 'round_limit' ? { ...cursor, budgetEndRound: cursor.budgetEndRound + 16 } : cursor;
    const timestamp = nowIso();
    await tx.agentRun.update({ where: { id: current.id }, data: { state: 'queued', pauseReason: null, cursorJson: JSON.stringify(next), leaseToken: null, leaseExpiresAt: null, updatedAt: timestamp } });
    await tx.conversation.update({ where: { id: current.conversationId }, data: { activeRunId: current.id, updatedAt: timestamp } });
    await appendRunEvent(tx, current.id, 'run_state', { type: 'run_state', runId: current.id, conversationId: current.conversationId, state: 'queued' });
    return current;
  });
  scheduleRun(run.id, stream, contextService);
  return run;
}

export async function stopRun(runId: string) {
  return prisma.$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({ where: { id: runId } });
    if (!run) throw new DomainError('NOT_FOUND', '请求不存在', 404);
    if (run.state !== 'queued' && run.state !== 'running' && run.state !== 'waiting_approval') throw new DomainError('RUN_NOT_STOPPABLE', '这个请求已经结束', 409);
    const timestamp = nowIso();
    await tx.agentRun.update({ where: { id: run.id }, data: { state: 'paused', pauseReason: 'user_stopped', leaseToken: null, leaseExpiresAt: null, updatedAt: timestamp } });
    await appendRunEvent(tx, run.id, 'run_state', { type: 'run_state', runId: run.id, conversationId: run.conversationId, state: 'paused', pauseReason: 'user_stopped', message: '已暂停后续处理' });
    return run;
  });
}

export async function applyExecutorSideEffect(runId: string, token: string, messageId: string, data: { content: string; status?: 'streaming' | 'completed' | 'failed'; toolCalls?: string | null }) {
  await ownsLease(runId, token);
  await prisma.message.update({ where: { id: messageId }, data });
}

async function pauseExpiredRuns() {
  const running = await prisma.agentRun.findMany({ where: { state: 'running' } });
  for (const run of running) {
    if (run.leaseExpiresAt && run.leaseExpiresAt > nowIso()) continue;
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.agentRun.findUnique({ where: { id: run.id } });
      if (!fresh || fresh.state !== 'running') return;
      if (fresh.leaseExpiresAt && fresh.leaseExpiresAt > nowIso()) return;
      const timestamp = nowIso();
      const cursor = readCursor(fresh.cursorJson);
      if (cursor.assistantMessageId) await tx.message.updateMany({ where: { id: cursor.assistantMessageId, status: 'streaming' }, data: { status: 'failed' } });
      await tx.agentRun.update({ where: { id: fresh.id }, data: { state: 'paused', pauseReason: 'interrupted', leaseToken: null, leaseExpiresAt: null, updatedAt: timestamp } });
      await appendRunEvent(tx, fresh.id, 'run_state', { type: 'run_state', runId: fresh.id, conversationId: fresh.conversationId, state: 'paused', pauseReason: 'interrupted', message: '处理被中断。可以继续此请求。' });
    });
  }
}

async function enqueueQueued() {
  if (!schedulerStream || !schedulerContext) return;
  const running = await prisma.agentRun.findMany({ where: { state: 'running' }, select: { id: true, leaseExpiresAt: true } });
  const orphans = running.filter((run) => !runningIds.has(run.id) && Boolean(run.leaseExpiresAt && run.leaseExpiresAt > nowIso())).length;
  const room = MAX_LOOPS - slots - pending.length - orphans;
  if (room <= 0) return;
  const queued = await prisma.agentRun.findMany({ where: { state: 'queued' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  let added = 0;
  for (const run of queued) {
    if (added >= room) break;
    if (runningIds.has(run.id) || pending.some((item) => item.runId === run.id)) continue;
    const conversation = await prisma.conversation.findUnique({ where: { id: run.conversationId }, select: { activeRunId: true } });
    if (conversation?.activeRunId !== run.id) continue;
    scheduleRun(run.id, schedulerStream, schedulerContext);
    added += 1;
  }
}

export async function checkAgentRuns(stream?: ModelStream, contextService?: ContextService) {
  if (stream) schedulerStream = stream;
  if (contextService) schedulerContext = contextService;
  if (ticking) return;
  ticking = true;
  try {
    await recoverExpiredDecisions();
    await pauseExpiredRuns();
    await enqueueQueued();
    await pump();
  } finally {
    ticking = false;
  }
}

export function startRunScheduler(stream: ModelStream, contextService: ContextService, intervalMs = 2000) {
  void checkAgentRuns(stream, contextService);
  const timer = setInterval(() => { void checkAgentRuns(stream, contextService); }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function bootRuns(stream: ModelStream, contextService: ContextService) {
  await checkAgentRuns(stream, contextService);
}

export async function activeRunView(conversationId: string) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { activeRunId: true } });
  if (!conversation) throw Object.assign(new Error('会话不存在'), { status: 404 });
  if (!conversation.activeRunId) return null;
  return runView(conversation.activeRunId);
}

export async function runView(runId: string) {
  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!run) return null;
  return { id: run.id, conversationId: run.conversationId, state: run.state, pauseReason: run.pauseReason, errorCode: run.errorCode, errorMessage: run.errorMessage, sourceUserMessageId: run.sourceUserMessageId, createdAt: run.createdAt, updatedAt: run.updatedAt, completedAt: run.completedAt };
}

export async function runEvents(runId: string, after: number) {
  const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { id: true } });
  if (!run) throw new DomainError('NOT_FOUND', '请求不存在', 404);
  const events = await prisma.agentRunEvent.findMany({ where: { runId, seq: { gt: after } }, orderBy: { seq: 'asc' } });
  return events.map((event) => ({ seq: event.seq, type: event.type, data: JSON.parse(event.dataJson), createdAt: event.createdAt }));
}
