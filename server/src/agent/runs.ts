import { coordinatorWork } from '../application/coordinator-work.js';
import { ReplyStream } from './reply-stream.js';
import { resolveImages } from './image-search.js';
import { parseMessageBlocks, projectBlocks } from './content-blocks.js';
import { sourceReadTools, sourcesFromTool } from './assistant-sources.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChatEvent, ModelMessage, ModelToolDefinition, PageContext, ModelDelta } from '../agent.js';
import { appendAutoMemoryAssistant, beginAutoMemoryTurn, completeAutoMemoryTurn, failAutoMemoryTurn } from '../application/auto-memory-chat.js';
import { canonical } from '../application/commands.js';
import { ContextService, type SummaryMetric } from '../application/conversation.js';
import { checkKnowledgeScope } from '../application/knowledge.js';
import { ownerActor } from '../application/security.js';
import type { ToolCall } from '../application/workspace.js';
import { DomainError } from '../domain/task.js';
import { prisma } from '../infrastructure/prisma.js';
import { enabledSkillCatalog } from '../application/skills.js';
import { assembleRunMessages } from './assemble.js';
import { buildContextStats, contextTotals, type ContextStats } from './context-stats.js';
import { packModelMessages, textTokens } from './context-budget.js';
import { initialToolGroups, toolGroupNames, toolGroupSchema, toolsForGroups, loadedFamilies, loadToolsInput, readSourceInput, mediaInstructionsFor, scopeGroupsFor, isGroupAllowedFor, type ToolGroup } from './tool-loading.js';
import { getAssistantIdentity, isAssistantIdentityId } from './identities.js';
import { htmlBlockPrompt } from './html-block.js';
import { htmlBlockPolicy } from '../application/html-block-settings.js';
import { withChatAttachments } from '../application/chat-attachments.js';
import { builtinToolDefinitions, isBuiltinTool, CAPABILITY_UNAVAILABLE } from './capabilities.js';
import { executeBuiltinTool, type BuiltinResult } from './builtin-tools.js';
import { WEB_TOOL_LIMITS, webToolLimitExceeded } from './web-search.js';
import { contextFromRequest, validateScopeAndResolveIds, type StoredChatContext } from './chat-context.js';
import { recoverExpiredDecisions } from './decision.js';
import { appendRunEvent } from './events.js';
import { builtinToolMessageId } from './ids.js';
import { waitRuns } from './wake.js';
import { TextBatcher } from './text-batcher.js';
import { currentLocale } from '../i18n/index.js';

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
  loadSkill: z.boolean().optional(),
  toolGroups: z.array(toolGroupSchema).optional(),
  offeredToolGroups: z.array(toolGroupSchema).optional(),
  webSearchCalls: z.number().int().min(0).optional(),
  webFetchCalls: z.number().int().min(0).optional(),
  summaryCalls: z.array(z.object({ estimatedInputTokens: z.number(), estimatedOutputTokens: z.number(), actual: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional(), cachedInputTokens: z.number().optional(), model: z.string().optional() }).nullable(), durationMs: z.number(), fallback: z.boolean() })).optional(),
});
export type RunCursor = z.infer<typeof runCursorSchema>;

export type ModelStream = (messages: ModelMessage[], signal?: AbortSignal, includeTools?: boolean, tools?: ModelToolDefinition[], identityId?: string) => AsyncIterable<ModelDelta>;

const initialCursor = (): RunCursor => ({ schemaVersion: 1, phase: 'model', round: 0, budgetEndRound: 16, assistantMessageId: null, nextToolIndex: 0 });

let slots = 0;
const pending: Array<{ runId: string; stream: ModelStream; contextService: ContextService }> = [];
const runningIds = new Set<string>();
const activeModelControllers = new Map<string, AbortController>();
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

async function completeOpenAssistant(tx: { message: { updateMany(args: { where: { id: string; status: 'streaming' }; data: { status: 'completed' } }): Promise<unknown> } }, cursorJson: string) {
  let assistantMessageId: string | null = null;
  try { assistantMessageId = readCursor(cursorJson).assistantMessageId; } catch { return; }
  if (!assistantMessageId) return;
  await tx.message.updateMany({ where: { id: assistantMessageId, status: 'streaming' }, data: { status: 'completed' } });
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
    if (data.type === 'message_delta' && !data.compatibilityProjection && data.messageId && data.delta) {
      const message = await tx.message.findUniqueOrThrow({ where: { id: data.messageId } });
      await tx.message.update({ where: { id: data.messageId }, data: { content: message.content + data.delta } });
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

async function addRunUsage(runId: string, token: string, usage: import('../agent.js').ModelUsage) {
  await prisma.$transaction(async tx => {
    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.leaseToken !== token || run.state !== 'running' || !run.leaseExpiresAt || run.leaseExpiresAt <= nowIso()) throw new DomainError('LEASE_LOST', '这次请求已经失去执行权', 409);
    // SQLite NULL + increment stays NULL. Initialize only fields actually
    // reported; absent usage is not zero usage.
    await tx.agentRun.update({ where: { id: runId }, data: {
      ...(typeof usage.inputTokens === 'number' ? { inputTokens: (run.inputTokens ?? 0) + usage.inputTokens } : {}),
      ...(typeof usage.cachedInputTokens === 'number' ? { cachedInputTokens: (run.cachedInputTokens ?? 0) + usage.cachedInputTokens } : {}),
      ...(typeof usage.outputTokens === 'number' ? { outputTokens: (run.outputTokens ?? 0) + usage.outputTokens } : {}),
      ...(usage.model ? { model: usage.model } : {}), updatedAt: nowIso(),
    } });
  });
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
  const cursor = readCursor(run.cursorJson);
  const identityId = readContext(run.contextJson).identityId ?? 'work';
  if (stored.length) {
    // Existing in-flight runs keep their full capability set. New user turns
    // start with lazy groups; source recovery is available to both generations.
    if (!cursor.toolGroups) await saveCursor(runId, token, { ...cursor, toolGroups: scopeGroupsFor(identityId, [...toolGroupNames]) });
    return stored;
  }
  const skills = await enabledSkillCatalog(identityId);
  const source = await prisma.message.findUnique({ where: { id: run.sourceUserMessageId }, select: { content: true } });
  const summaryCalls: SummaryMetric[] = [];
  const messages = await assembleRunMessages({
    runId,
    conversationId: run.conversationId,
    sourceUserMessageId: run.sourceUserMessageId,
    context: readContext(run.contextJson),
    identityId,
    userText: source?.content ?? '',
    contextService,
    skills,
    onSummary: async metric => { summaryCalls.push(metric); },
  });
  await ownsLease(runId, token);
  for (const metric of summaryCalls) if (metric.actual) await addRunUsage(runId, token, metric.actual);
  await saveMessages(runId, token, messages);
  await saveCursor(runId, token, { ...cursor, loadSkill: skills.length > 0, toolGroups: initialToolGroups(source?.content ?? '', readContext(run.contextJson).page, identityId), summaryCalls });
  return messages;
}

async function modelTurn(runId: string, token: string, stream: ModelStream, contextService: ContextService) {
  const run = await ownsLease(runId, token);
  const started = readCursor(run.cursorJson);
  if (started.round >= started.budgetEndRound) {
    await pauseOwned(runId, token, 'round_limit', '这一轮处理已到上限。可以继续此请求。');
    return 'paused' as const;
  }
  const messages = packModelMessages(await ensureMessages(runId, token, contextService));
  const owned = await ownsLease(runId, token);
  const cursor = readCursor(owned.cursorJson);
  const identityId = readContext(owned.contextJson).identityId ?? 'work';
  const tools = cursor.toolGroups ? toolsForGroups(cursor.toolGroups, cursor.loadSkill, identityId) : builtinToolDefinitions({ loadSkill: cursor.loadSkill });
  const offered = new Set(tools.map(t => t.function.name));
  if (cursor.toolGroups?.includes('media') && !String(messages[0]?.content).includes('【富媒体表达】\nSVG')) messages.splice(1, 0, { role: 'system', content: `【按需富媒体规则】\n${mediaInstructionsFor(identityId)}\n${htmlBlockPrompt(await htmlBlockPolicy())}` });
  await saveMessages(runId, token, messages.filter(m => !(m.role === 'system' && String(m.content).startsWith('【按需富媒体规则】'))));
  const stats = buildContextStats({ runId, round: cursor.round, messages, tools, fullTools: identityId === 'work' ? builtinToolDefinitions({ loadSkill: cursor.loadSkill }) : toolsForGroups(scopeGroupsFor(identityId, [...toolGroupNames]), cursor.loadSkill, identityId), loadedGroups: cursor.toolGroups ?? ['legacy-all'], summaryCalls: cursor.summaryCalls });
  const publishStats = async () => {
    const earlier = await prisma.agentRunEvent.findMany({ where: { runId, type: 'context_stats' }, orderBy: { seq: 'asc' }, select: { dataJson: true } });
    stats.totals = contextTotals([...earlier.map(e => (JSON.parse(e.dataJson) as { contextStats: ContextStats }).contextStats), stats], cursor.summaryCalls);
    await recordEvent(runId, token, { type: 'context_stats', contextStats: stats });
  };
  await publishStats();
  const modelStarted = Date.now();
  const assistant = await prisma.message.create({ data: { conversationId: owned.conversationId, role: 'assistant', content: '', status: 'streaming', createdAt: nowIso() } });
  const nextCursor = { ...cursor, assistantMessageId: assistant.id, offeredToolGroups: cursor.toolGroups };
  await saveCursor(runId, token, nextCursor);
  await recordEvent(runId, token, { type: 'message_start', conversationId: owned.conversationId, messageId: assistant.id });
  const controller = new AbortController();
  activeModelControllers.set(runId, controller);
  let reply: ReplyStream | undefined;
  let presentationIndex: number | undefined;
  const partialCalls = new Map<number, { name: string; arguments: string }>();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, MODEL_TIMEOUT_MS);
  timer.unref?.();
  let text = '';
  let rawText = '';
  const calls: ToolCall[] = [];
  const batcher = new TextBatcher(
    (delta) => recordEvent(runId, token, { type: 'message_delta', conversationId: run.conversationId, messageId: assistant.id, delta }),
    () => controller.abort(),
  );
  try {
    for await (const chunk of stream(messages, controller.signal, true, tools, identityId)) {
      if (controller.signal.aborted) throw new DomainError('LEASE_LOST', '请求已停止', 409);
      if (chunk.toolDelta) {
        const delta = chunk.toolDelta;
        const prior = partialCalls.get(delta.index);
        const current = { name: delta.name, arguments: (prior?.arguments ?? '') + delta.argumentsDelta };
        partialCalls.set(delta.index, current);
        if (presentationIndex === delta.index && current.name !== 'present_reply') throw new Error('展示工具名称发生冲突');
        if (current.name === 'present_reply' && offered.has('present_reply')) {
          if (presentationIndex !== undefined && presentationIndex !== delta.index) throw new Error('一次只能提交一个富媒体回答');
          if (!reply) {
            presentationIndex = delta.index;
            await batcher.finish();
            reply = new ReplyStream(runId, token, owned.conversationId, assistant.id, (searchId, ids) => resolveImages(owned.conversationId, searchId, ids), () => controller.abort(), text);
            await reply.write(current.arguments);
          } else await reply.write(delta.argumentsDelta);
        }
      }
      if (chunk.text) {
        if (reply) throw new Error('富媒体回答之后不能再追加另一份正文');
        rawText += chunk.text;
        text += chunk.text;
        await batcher.add(chunk.text);
      }
      if (chunk.toolCalls) calls.push(...chunk.toolCalls);
      if (chunk.usage) {
        stats.actual ??= {};
        for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens'] as const) if (typeof chunk.usage[key] === 'number') stats.actual[key] = (stats.actual[key] ?? 0) + chunk.usage[key]!;
        if (chunk.usage.model) stats.actual.model = chunk.usage.model;
      }
    }
    await batcher.finish();
    if (reply) {
      if (calls.length !== 1 || calls[0].name !== 'present_reply') throw new Error('富媒体回答必须单独提交；业务修改继续走原有审批');
      text = await reply.finish();
      await recordEvent(runId, token, { type: 'message_delta', messageId: assistant.id, delta: text, compatibilityProjection: true });
      calls.length = 0;
    } else if (offered.has('present_reply') && calls.some((call) => call.name === 'present_reply')) throw new Error('当前模型没有提供工具参数增量，无法完成实时富媒体回答');
  } catch (error) {
    clearTimeout(timer);
    let failure = error;
    try { if (reply) text = await reply.fail('回复未完成'); await batcher.finish(); } catch (writeError) { failure = writeError; }
    try { await applyExecutorSideEffect(runId, token, assistant.id, { content: text, status: 'failed' }); }
    catch (leaseError) { if (!isLeaseLoss(leaseError)) throw leaseError; }
    if (timedOut) throw Object.assign(new Error('模型请求超时'), { code: 'MODEL_TIMEOUT' });
    throw failure;
  } finally {
    stats.durationMs = Date.now() - modelStarted;
    stats.estimatedOutputTokens = textTokens(rawText) + (partialCalls.size ? textTokens(JSON.stringify([...partialCalls.values()])) : textTokens(JSON.stringify(calls)));
    try { if (stats.actual) await addRunUsage(runId, token, stats.actual); await publishStats(); } catch (error) { if (!isLeaseLoss(error)) throw error; }
    clearTimeout(timer);
    if (activeModelControllers.get(runId) === controller) activeModelControllers.delete(runId);
  }
  calls.forEach((call, index) => { call.id ??= `call_${cursor.round}_${index}`; });
  await applyExecutorSideEffect(runId, token, assistant.id, { content: text, status: 'completed', toolCalls: calls.length ? JSON.stringify(calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } }))) : null });
  await appendAutoMemoryAssistant(owned.sourceUserMessageId, assistant.id);
  await recordEvent(runId, token, { type: 'message_end', conversationId: owned.conversationId, messageId: assistant.id, status: 'completed' });
  const assistantMessage: ModelMessage = {
    role: 'assistant',
    content: text || null,
    ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id ?? '', type: 'function' as const, function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } })) } : {}),
  };
  messages.splice(0, messages.length, ...messages.filter(m => !(m.role === 'system' && String(m.content).startsWith('【按需富媒体规则】'))));
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
  let cursor = readCursor(run.cursorJson);
  const context = readContext(run.contextJson);
  const identityId = context.identityId ?? 'work';
  const offeredGroups = cursor.offeredToolGroups ?? cursor.toolGroups;
  const offeredFamilies = offeredGroups ? loadedFamilies(scopeGroupsFor(identityId, offeredGroups)) : null;
  const offered = new Set((offeredGroups ? toolsForGroups(offeredGroups, cursor.loadSkill, identityId) : builtinToolDefinitions({ loadSkill: cursor.loadSkill })).map(t => t.function.name));
  const assistantMessageId = cursor.assistantMessageId;
  if (!assistantMessageId) throw new DomainError('RUN_FAILED', '工具阶段缺少助手消息', 500);
  const assistant = await prisma.message.findUnique({ where: { id: assistantMessageId } });
  if (!assistant || assistant.status !== 'completed' || !assistant.toolCalls) throw new DomainError('RUN_FAILED', '不完整的模型回复不能执行工具', 409);
  const calls = JSON.parse(assistant.toolCalls) as Array<{ id: string; function: { name: string; arguments: string } }>;
  const messages = JSON.parse(run.modelMessagesJson) as ModelMessage[];
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
    else if (!offered.has(call.function.name) && !isBuiltinTool(call.function.name)) result = CAPABILITY_UNAVAILABLE;
    else if (!offered.has(call.function.name)) result = { success: false, code: 'TOOL_NOT_LOADED', error: '本轮未加载此工具。先用 load_tools 加载对应组，下一轮再调用；本次未执行。' };
    else if (call.function.name === 'load_tools') {
      const requested = loadToolsInput.safeParse(args);
      if (!requested.success) result = { success: false, code: 'INVALID_TOOL_ARGUMENTS', error: '请指定有效的能力组' };
      else {
        const disallowed = requested.data.groups.filter((group) => !isGroupAllowedFor(identityId, group));
        if (disallowed.length) result = { success: false, code: 'GROUP_NOT_ALLOWED', error: `这些能力组不属于当前助手：${disallowed.join('、')}` };
        else {
          cursor = { ...cursor, toolGroups: [...new Set([...(cursor.toolGroups ?? []), ...requested.data.groups])] };
          await saveCursor(runId, token, cursor);
          result = { success: true, data: { groups: cursor.toolGroups, availableNextTurn: toolsForGroups(cursor.toolGroups!, cursor.loadSkill, identityId).map(t => t.function.name), note: '只加载定义，未修改业务数据；下一轮调用。' } };
        }
      }
    } else if (call.function.name === 'read_context_source') {
      const parsed = readSourceInput.safeParse(args);
      if (!parsed.success) result = { success: false, code: 'INVALID_TOOL_ARGUMENTS', error: '原文读取参数无效' };
      else {
        const row = await prisma.message.findFirst({ where: { id: parsed.data.messageId, conversationId: run.conversationId } });
        if (!row) result = { success: false, code: 'NOT_FOUND', error: '当前会话没有这条消息' };
        else {
          const [attached] = await withChatAttachments([row]);
          const content = attached.content;
          const end = Math.min(content.length, parsed.data.offset + parsed.data.limit);
          result = { success: true, data: { messageId: row.id, role: row.role, offset: parsed.data.offset, totalCharacters: content.length, content: content.slice(parsed.data.offset, end), nextOffset: end < content.length ? end : null } };
        }
      }
    } else if (call.function.name === 'propose_changes' && Array.isArray(args.operations) && args.operations.some(op => op && typeof op === 'object' && typeof (op as Record<string, unknown>).family === 'string' && !getAssistantIdentity(identityId).writeFamilies.includes(String((op as Record<string, unknown>).family)))) {
      result = { success: false, code: 'FAMILY_NOT_ALLOWED', error: '该修改类型不属于当前助手，未创建方案。' };
    } else if (call.function.name === 'propose_changes' && cursor.toolGroups && Array.isArray(args.operations) && args.operations.some(op => op && typeof op === 'object' && typeof (op as Record<string, unknown>).family === 'string' && !offeredFamilies!.includes(String((op as Record<string, unknown>).family)))) {
      result = { success: false, code: 'TOOL_NOT_LOADED', error: '方案包含未加载的修改类型。先加载全部所需的 *_write 组；本次未创建方案。' };
    }
    else if (call.function.name === 'propose_changes' && sawPropose) result = { success: false, code: 'INVALID_TOOL_ARGUMENTS', error: '一次回复只能提交一份修改方案' };
    else if (webToolLimitExceeded(call.function.name, cursor)) result = { success: false, code: 'WEB_TOOL_LIMIT', error: `本次任务的${call.function.name === 'web_search' ? '联网搜索' : '网页读取'}次数已达上限（${WEB_TOOL_LIMITS[call.function.name]} 次）。请基于已有结果作答，或建议用户新开任务。` };
    else if (call.function.name === 'propose_changes') {
      sawPropose = true;
      await saveCursor(runId, token, { ...cursor, nextToolIndex: index });
      result = await executeBuiltinTool({ name: call.function.name, args, context, run: { id: runId, leaseToken: token, conversationId: run.conversationId, assistantMessageId, sourceUserMessageId: run.sourceUserMessageId }, toolCallId: call.id, loadSkill: cursor.loadSkill === true });
    } else {
      result = await executeBuiltinTool({ name: call.function.name, args, context, run: { id: runId, leaseToken: token, conversationId: run.conversationId, assistantMessageId, sourceUserMessageId: run.sourceUserMessageId }, toolCallId: call.id, loadSkill: cursor.loadSkill === true });
    }
    if (result.success && call.function.name === 'get_change_schema' && cursor.toolGroups) {
      const group = `${String(args.family)}_write` as ToolGroup;
      if (toolGroupSchema.safeParse(group).success && isGroupAllowedFor(identityId, group)) { cursor = { ...cursor, toolGroups: [...new Set([...cursor.toolGroups, group])] }; await saveCursor(runId, token, cursor); }
    }
    const sources = await sourcesFromTool(call.function.name, args, result);
    if (sourceReadTools.has(call.function.name)) {
      await prisma.$transaction(async (tx) => {
        const owned = await tx.agentRun.findUnique({ where: { id: runId } });
        if (!owned || owned.state !== 'running' || owned.leaseToken !== token || !owned.leaseExpiresAt || owned.leaseExpiresAt <= nowIso()) throw new DomainError('LEASE_LOST', '这次请求已经失去执行权', 409);
        const conversation = await tx.conversation.findUnique({ where: { id: owned.conversationId }, select: { activeRunId: true } });
        if (conversation?.activeRunId !== runId) throw new DomainError('RUN_SUPERSEDED', '已有更新的请求', 409);
        const row = await tx.message.findUniqueOrThrow({ where: { id: assistantMessageId }, select: { partsJson: true } });
        const partId = `sources:${call.id}`;
        const parts = (JSON.parse(row.partsJson || '[]') as Array<{ type: string; id?: string; sources?: typeof sources }>).filter((part) => part.id !== partId);
        parts.push({ type: 'assistant_sources', id: partId, sources });
        await tx.message.update({ where: { id: assistantMessageId }, data: { partsJson: JSON.stringify(parts) } });
        await appendRunEvent(tx, runId, 'sources', { type: 'sources', runId, conversationId: run.conversationId, messageId: assistantMessageId, sources: parts.flatMap((part) => part.sources ?? []) });
      });
    }
    const content = JSON.stringify({ toolName: call.function.name, toolCallId: call.id, sourceMessageId: builtinToolMessageId(runId, assistantMessageId, call.id), assistantMessageId, ...publicResult(result) });
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
    const webCounters = result.success && call.function.name === 'web_search' ? { webSearchCalls: (cursor.webSearchCalls ?? 0) + 1 }
      : result.success && call.function.name === 'read_webpage' ? { webFetchCalls: (cursor.webFetchCalls ?? 0) + 1 } : {};
    if (Object.keys(webCounters).length) cursor = { ...cursor, ...webCounters };
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

export async function startChat(input: { conversationId?: string; message: string; pageContext?: PageContext; context?: unknown; requestKey?: string; identityId?: string }) {
  const message = input.message.trim();
  if (!message) throw new DomainError('INVALID_MESSAGE', '消息不能为空', 400);
  if (input.requestKey !== undefined && (input.requestKey.trim().length < 1 || input.requestKey.length > 200)) throw new DomainError('INVALID_REQUEST', 'requestKey 无效', 400);
  const requestKey = input.requestKey?.trim() || `ephemeral:${randomUUID()}`;
  // 身份以会话归属为准：已有会话按会话身份走并拒绝不一致的显式指定；新会话用请求声明，默认工作助手。
  let identityId: string = input.identityId ?? 'work';
  if (input.conversationId) {
    const existing = await prisma.conversation.findUnique({ where: { id: input.conversationId }, select: { id: true, identityId: true } });
    if (!existing) throw Object.assign(new Error('会话不存在'), { status: 404 });
    if (input.identityId && input.identityId !== existing.identityId) throw new DomainError('IDENTITY_MISMATCH', '这个会话属于另一位助手，请切换到对应身份或新开一个会话', 409);
    identityId = existing.identityId;
  }
  if (!isAssistantIdentityId(identityId)) throw new DomainError('INVALID_IDENTITY', '未知的助手身份', 400);
  const requestedContext = contextFromRequest({ context: input.context, pageContext: input.pageContext });
  // Hash the stable request, not the resolved data revisions, so a reconnect reuses
  // the first snapshot even when the underlying objects have since changed.
  const requestHash = createHash('sha256').update(canonical({ message, identityId, context: requestedContext })).digest('hex');
  const accepted = await prisma.agentRun.findUnique({ where: { requestKey } });
  if (accepted) {
    if (accepted.requestHash !== requestHash || (input.conversationId && input.conversationId !== accepted.conversationId)) throw new DomainError('IDEMPOTENCY_CONFLICT', '相同请求标识不能提交不同内容', 409);
    return accepted;
  }
  let conversationId = input.conversationId;
  if (conversationId) {
    const existingConversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true } });
    if (!existingConversation) throw Object.assign(new Error('会话不存在'), { status: 404 });
  } else {
    const timestamp = nowIso();
    conversationId = (await prisma.conversation.create({ data: { identityId, createdAt: timestamp, updatedAt: timestamp } })).id;
  }
  const stored = await validateScopeAndResolveIds(requestedContext);
  stored.identityId = identityId;
  // The request's UI language (X-WWA-Language / Accept-Language) decides the reply language.
  if (currentLocale() === 'en') stored.language = 'en';
  if (stored.referencedApprovalId) {
    if (!input.conversationId) throw new DomainError('INVALID_REFERENCE', '这份方案不属于当前会话', 400);
    const referenced = await prisma.approval.findUnique({ where: { id: stored.referencedApprovalId }, select: { conversationId: true } });
    if (!referenced || referenced.conversationId !== input.conversationId) throw new DomainError('INVALID_REFERENCE', '这份方案不属于当前会话', 400);
  }
  const topicId = stored.scope.kind === 'topic' ? stored.scope.topicId : null;
  await checkKnowledgeScope(prisma, ownerActor, stored.scope.kind === 'all' ? null : topicId);
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
        await completeOpenAssistant(tx, old.cursorJson);
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
    const { timeZoneSource, ...publicContext } = stored;
    await appendRunEvent(tx, created.id, 'user_context', { type: 'user_context', runId: created.id, conversationId, messageId: user.id, context: publicContext });
    await tx.conversation.update({ where: { id: conversationId }, data: { activeRunId: created.id, updatedAt: timestamp } });
    // 自动记忆提炼只属于工作助手；学习助手的长期记录走 learning_activity。
    if (getAssistantIdentity(identityId).autoMemory) await beginAutoMemoryTurn({ conversationId, userMessageId: user.id, topicId, createdAt: timestamp }, tx);
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
  const stopped = await prisma.$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({ where: { id: runId } });
    if (!run) throw new DomainError('NOT_FOUND', '请求不存在', 404);
    if (run.state !== 'queued' && run.state !== 'running' && run.state !== 'waiting_approval') throw new DomainError('RUN_NOT_STOPPABLE', '这个请求已经结束', 409);
    const timestamp = nowIso();
    const cursor = readCursor(run.cursorJson);
    if (cursor.assistantMessageId) {
      const message = await tx.message.findUnique({ where: { id: cursor.assistantMessageId } });
      const blocks = parseMessageBlocks(message?.blocksJson).map((block) => block.status === 'pending' ? { ...block, status: 'error' as const, error: '已停止，内容未完成' } : block);
      if (blocks.length) await tx.message.update({ where: { id: cursor.assistantMessageId }, data: { blocksJson: JSON.stringify({ schemaVersion: 1, blocks }), content: projectBlocks(blocks), status: 'failed' } });
    }
    await completeOpenAssistant(tx, run.cursorJson);
    await tx.agentRun.update({ where: { id: run.id }, data: { state: 'paused', pauseReason: 'user_stopped', leaseToken: null, leaseExpiresAt: null, updatedAt: timestamp } });
    await appendRunEvent(tx, run.id, 'run_state', { type: 'run_state', runId: run.id, conversationId: run.conversationId, state: 'paused', pauseReason: 'user_stopped', message: '已暂停后续处理' });
    return run;
  });
  activeModelControllers.get(runId)?.abort();
  return stopped;
}

export async function applyExecutorSideEffect(runId: string, token: string, messageId: string, data: { content: string; status?: 'streaming' | 'completed' | 'failed'; toolCalls?: string | null }) {
  await prisma.$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({ where: { id: runId } });
    const conversation = run ? await tx.conversation.findUnique({ where: { id: run.conversationId }, select: { activeRunId: true } }) : null;
    if (!run || run.leaseToken !== token || run.state !== 'running' || !run.leaseExpiresAt || run.leaseExpiresAt <= nowIso() || conversation?.activeRunId !== runId) throw new DomainError('LEASE_LOST', '这次请求已经失去执行权', 409);
    await tx.message.update({ where: { id: messageId }, data });
  });
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
  void coordinatorWork(() => checkAgentRuns(stream, contextService));
  const timer = setInterval(() => { void coordinatorWork(() => checkAgentRuns(stream, contextService)); }, intervalMs);
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
