import { z } from 'zod';

export const providerSchema = z.enum(['codex', 'claude']);
export type Provider = z.infer<typeof providerSchema>;
export const permissionsSchema = z.object({ profile: z.enum(['read_only', 'workspace_write']).default('read_only'), allowShell: z.boolean().default(false) }).strict();
export type Permissions = z.infer<typeof permissionsSchema>;
const proposedCommandSchema = z.object({ kind: z.enum(['task.create', 'task.update', 'task.reorder', 'memory.create', 'memory.update', 'memory.retire']), targetId: z.string().min(1).optional(), expectedRevision: z.number().int().positive().optional(), input: z.record(z.unknown()) }).strict();
const resultObjectSchema = z.object({
  outcome: z.enum(['ready_for_review', 'needs_input', 'blocked_permissions', 'partial']),
  summary: z.string().min(1).max(100000),
  questions: z.array(z.string().min(1).max(10000)).max(30).default([]),
  artifacts: z.array(z.object({ name: z.string().min(1).max(300), kind: z.enum(['text', 'file', 'link']).default('text'), content: z.string().max(1000000).optional(), path: z.string().max(4096).optional(), uri: z.union([z.string().url(), z.literal('')]).optional() }).strict()).max(100).default([]),
  checks: z.array(z.object({ name: z.string().max(1000), passed: z.boolean(), detail: z.string().max(10000).default('') }).strict()).max(100).default([]),
  unfinished: z.array(z.string().min(1).max(10000)).max(100).default([]),
  proposedCommands: z.array(proposedCommandSchema).max(50).default([]),
}).strict().superRefine((value, ctx) => { if (value.outcome === 'needs_input' && !value.questions.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['questions'], message: '待输入结果必须包含问题' }); });
export const resultSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object' || !('proposedCommandsJson' in raw)) return raw;
  const { proposedCommandsJson, ...value } = raw as Record<string, unknown>;
  if ('proposedCommands' in value || typeof proposedCommandsJson !== 'string') return raw;
  try { return { ...value, proposedCommands: JSON.parse(proposedCommandsJson) }; } catch { return raw; }
}, resultObjectSchema);
export type RunResult = z.infer<typeof resultSchema>;
export const resultJsonSchema = { type: 'object', additionalProperties: false, properties: {
  outcome: { type: 'string', enum: ['ready_for_review', 'needs_input', 'blocked_permissions', 'partial'] }, summary: { type: 'string' },
  questions: { type: 'array', items: { type: 'string' } },
  artifacts: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['text', 'file', 'link'] }, content: { type: 'string' }, path: { type: 'string' }, uri: { type: 'string' } }, required: ['name', 'kind', 'content', 'path', 'uri'] } },
  checks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' } }, required: ['name', 'passed', 'detail'] } },
  unfinished: { type: 'array', items: { type: 'string' } },
  proposedCommandsJson: { type: 'string', description: 'JSON array of suggested task.create/task.update/task.reorder or memory.create/memory.update/memory.retire commands; each has kind, optional targetId and expectedRevision, and input. Memory commands must include source evidence with type, id, revision. Never execute these commands yourself; use [] when none.' },
}, required: ['outcome', 'summary', 'questions', 'artifacts', 'checks', 'unfinished', 'proposedCommandsJson'] };

export type WorkspaceInput = { path: string; hash: string; size: number };
export type Workspace = { kind: 'git' | 'directory'; sourcePath: string; workPath: string; baseHead?: string; sourceBranch?: string; branch?: string; excludedDirty: boolean; inputs?: WorkspaceInput[] };
export type LaunchSpec = { runId: string; provider: Provider; command: string; args: string[]; cwd: string; prompt: string; controlDir: string; finalOutputPath: string; externalSessionId?: string };
export type RunnerReceipt = { runId: string; token: string; supervisorPid: number; childPid?: number; createdAt: string; heartbeatAt: string; state: 'starting' | 'running' | 'ended'; exitCode?: number | null; signal?: string | null; error?: string; cancelled?: boolean };
export const terminalRunStates = ['returned', 'failed', 'cancelled', 'interrupted'] as const;
export function isTerminal(status: string) { return (terminalRunStates as readonly string[]).includes(status); }
