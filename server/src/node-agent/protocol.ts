/** Wire contract between the WWA server and a local executor (wwa-node). Shared by both sides. */
import { z } from 'zod';
import { permissionsSchema, providerSchema, resultSchema } from '../runner/contracts.js';

export const NODE_PROTOCOL_VERSION = 2;
/** Lease `accepts` values. A node sends the matching result fields only when the server lists them. */
export const NODE_RESULT_FEATURES = ['usage_v1', 'caps_v2'] as const;
/** A node that has not leased for this long is shown offline. */
export const NODE_ONLINE_MS = 90_000;
/** Leases renew on every heartbeat; an expired lease turns the job `lost`. */
export const JOB_LEASE_MS = 15 * 60_000;

const relPath = z.string().min(1).max(4096);
export const probePayloadSchema = z.object({ path: relPath }).strict();
export const preparePayloadSchema = z.object({ repoPath: relPath, branch: z.string().min(1).max(250), startPoint: z.string().min(1).max(250), worktreeName: z.string().min(1).max(200) }).strict();
const branchName = z.string().min(1).max(250);
const remoteName = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/).default('origin');
const sha = z.string().regex(/^[0-9a-f]{7,64}$/);
/** Cross-machine transfer: fetch a branch from the shared remote into refs/remotes/<remote>/<ref> and verify it is exactly `expect`. */
export const fetchSpecSchema = z.object({ remote: remoteName, ref: branchName, expect: sha }).strict();
export type FetchSpec = z.infer<typeof fetchSpecSchema>;
export const runPayloadSchema = z.object({
  repoPath: relPath,
  provider: providerSchema,
  permissions: permissionsSchema,
  /** Grant git metadata writes (commit / merge) inside the worktree. */
  gitWrite: z.boolean().default(false),
  /** Either reuse an existing worktree path reported earlier by this node, or create one. */
  worktree: z.union([
    z.object({ existing: relPath }).strict(),
    z.object({ create: z.object({ branch: z.string().min(1).max(250), startPoint: z.string().min(1).max(250), worktreeName: z.string().min(1).max(200), fetch: fetchSpecSchema.optional() }).strict() }).strict(),
  ]),
  /** Mechanical fetches before the AI starts (e.g. a subtask branch developed on another machine). */
  fetch: z.array(fetchSpecSchema).max(10).default([]),
  /** Mechanically push the worktree branch after the run (never forced) so another machine can merge it. */
  publish: z.object({ remote: remoteName }).strict().optional(),
  prompt: z.string().min(1).max(400_000),
  /** Facts the node computes after the run, independent of the AI's own claims. */
  expect: z.object({ includes: z.array(z.string().regex(/^[0-9a-f]{7,64}$/)).max(50).default([]), base: z.string().max(64).optional(), branch: z.string().max(250).optional() }).strict().default({}),
}).strict();
export const pushPayloadSchema = z.object({ worktree: relPath, branch: z.string().min(1).max(250), remote: z.string().min(1).max(100).default('origin') }).strict();
export const inventoryPayloadSchema = z.object({}).strict();
export const cleanupPayloadSchema = z.object({ worktrees: z.array(relPath).min(1).max(200), deleteBranches: z.boolean().default(false) }).strict();
export const pullRequestPayloadSchema = z.object({ worktree: relPath, branch: branchName, base: branchName, title: z.string().min(1).max(250), body: z.string().max(60_000).default(''), remote: remoteName }).strict();
export type CleanupPayload = z.infer<typeof cleanupPayloadSchema>;
export type PullRequestPayload = z.infer<typeof pullRequestPayloadSchema>;
export type ProbePayload = z.infer<typeof probePayloadSchema>;
export type PreparePayload = z.infer<typeof preparePayloadSchema>;
export type RunPayload = z.infer<typeof runPayloadSchema>;
export type PushPayload = z.infer<typeof pushPayloadSchema>;

export const jobKindSchema = z.enum(['probe', 'prepare', 'run', 'push', 'inventory', 'cleanup', 'pull_request']);
export type JobKind = z.infer<typeof jobKindSchema>;

const nullableInt = z.number().int().nonnegative().nullable().default(null);
/** CLI usage frozen on a run result. `raw` stays open so later CLI fields are not rejected. */
export const usageSchema = z.object({
  model: z.string().max(200).nullable().default(null),
  inputTokens: nullableInt,
  cachedInputTokens: nullableInt,
  outputTokens: nullableInt,
  numTurns: nullableInt,
  cliDurationMs: nullableInt,
  runDurationMs: nullableInt,
  costUsd: z.number().nonnegative().nullable().default(null),
  cliVersion: z.string().max(200).nullable().default(null),
  raw: z.unknown().optional(),
}).strict();
export type UsageReport = z.infer<typeof usageSchema>;
export function emptyDiff() {
  return { files: [] as Array<{ path: string; added: number; deleted: number; binary: boolean }>, filesChanged: 0, linesAdded: 0, linesDeleted: 0, truncated: false };
}
export const diffStatSchema = z.object({
  files: z.array(z.object({
    path: z.string().max(4096),
    added: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
    binary: z.boolean(),
  }).strict()).max(200),
  filesChanged: z.number().int().nonnegative().default(0),
  linesAdded: z.number().int().nonnegative().default(0),
  linesDeleted: z.number().int().nonnegative().default(0),
  truncated: z.boolean().default(false),
}).strict().default(emptyDiff);
export type DiffStat = z.infer<typeof diffStatSchema>;

/** Mechanically collected, read-only git facts about a worktree. */
export const gitFactsSchema = z.object({
  worktree: z.string().max(4096),
  branch: z.string().max(250).nullable(),
  head: z.string().max(64).nullable(),
  base: z.string().max(64).nullable().default(null),
  commits: z.array(z.object({ sha: z.string().max(64), subject: z.string().max(1000) })).max(500).default([]),
  status: z.array(z.string().max(4096)).max(500).default([]),
  mergeInProgress: z.boolean().default(false),
  unmerged: z.array(z.string().max(4096)).max(500).default([]),
  includes: z.record(z.boolean()).default({}),
  conflictMarkers: z.array(z.string().max(4096)).max(500).default([]),
  hooksChanged: z.boolean().default(false),
  diff: diffStatSchema,
}).strict();
export type GitFacts = z.infer<typeof gitFactsSchema>;

export const probeResultSchema = z.object({ toplevel: z.string().max(4096), rootCommit: z.string().max(64).nullable(), originUrl: z.string().max(2000).nullable(), branches: z.array(z.string().max(250)).max(500), head: z.string().max(64).nullable(), dirtyCount: z.number().int().min(0) }).strict();
export const prepareResultSchema = z.object({ worktree: z.string().max(4096), branch: z.string().max(250), head: z.string().max(64), replay: z.boolean().default(false), dirtyCount: z.number().int().min(0).default(0) }).strict();
export const runResultSchema = z.object({
  worktree: z.string().max(4096),
  sessionId: z.string().max(200).nullable().default(null),
  result: resultSchema.nullable(),
  error: z.string().max(20_000).nullable().default(null),
  stderrTail: z.string().max(20_000).default(''),
  facts: gitFactsSchema.nullable(),
  preHead: z.string().max(64).nullable().default(null),
  published: z.object({ remote: z.string().max(100), branch: z.string().max(250), head: z.string().max(64) }).strict().nullable().default(null),
  publishError: z.string().max(20_000).nullable().default(null),
  exitCode: z.number().int().nullable().default(null),
  usage: usageSchema.nullable().default(null),
}).strict();
export const pushResultSchema = z.object({ output: z.string().max(20_000), head: z.string().max(64).nullable() }).strict();

export const worktreeEntrySchema = z.object({
  path: z.string().max(4096),
  name: z.string().max(300),
  branch: z.string().max(250).nullable(),
  head: z.string().max(64).nullable(),
  dirtyCount: z.number().int().min(0),
  sizeBytes: z.number().nonnegative(),
  sizeTruncated: z.boolean().default(false),
  modifiedAt: z.string().max(40).nullable(),
  broken: z.boolean().default(false),
}).strict();
export type WorktreeEntry = z.infer<typeof worktreeEntrySchema>;
export const inventoryResultSchema = z.object({ worktrees: z.array(worktreeEntrySchema).max(2000), runs: z.object({ count: z.number().int().min(0), sizeBytes: z.number().nonnegative() }).strict(), freeBytes: z.number().nonnegative().nullable(), scannedAt: z.string().max(40) }).strict();
export type InventoryResult = z.infer<typeof inventoryResultSchema>;
export const cleanupResultSchema = z.object({
  removed: z.array(z.object({ path: z.string().max(4096), branch: z.string().max(250).nullable(), branchDeleted: z.boolean(), branchNote: z.string().max(2000).nullable().default(null) }).strict()).max(200),
  skipped: z.array(z.object({ path: z.string().max(4096), reason: z.string().max(2000) }).strict()).max(200),
  inventory: inventoryResultSchema,
}).strict();
export const pullRequestResultSchema = z.object({ url: z.string().max(2000), existing: z.boolean(), output: z.string().max(20_000).default('') }).strict();

const providerCapabilitySchema = z.object({ provider: providerSchema, available: z.boolean(), version: z.string().max(200).default(''), path: z.string().max(4096).default('') }).strict();
export const capabilitiesSchema = z.object({
  protocol: z.number().int(),
  version: z.string().max(100).default(''),
  platform: z.string().max(100).default(''),
  providers: z.array(providerCapabilitySchema).max(10).default([]),
  maxConcurrent: z.number().int().min(1).max(4).default(2),
  allowedRoots: z.array(z.string().max(4096)).max(50).default([]),
  freeBytes: z.number().nonnegative().nullable().default(null),
  /** GitHub CLI available locally (optional PR creation). */
  gh: z.boolean().default(false),
  /** Set by the desktop shell via WWA_NODE_MANAGED. Manual CLI stays `cli`. */
  managedBy: z.enum(['desktop', 'cli']).default('cli'),
  /** Log file path reported by the desktop shell. Manual CLI sends null. */
  logPath: z.string().max(4096).nullable().default(null),
  /** Latest lease or report failure summary. At most 500 characters and never a token. */
  lastError: z.string().max(500).nullable().default(null),
  startedAt: z.string().max(40).nullable().default(null),
}).strict();
/** Input shape, so callers that omit the new optional fields (the current executor) still typecheck. `providers` stays required: the executor always sends the array and reads `.providers` without a null check. `parse` fills the defaults. */
export type NodeCapabilities = Omit<z.input<typeof capabilitiesSchema>, 'providers'> & { providers: Array<z.input<typeof providerCapabilitySchema>> };

export const leaseRequestSchema = z.object({ capabilities: capabilitiesSchema, activeJobIds: z.array(z.string().min(1).max(100)).max(50).default([]), max: z.number().int().min(0).max(4).default(1) }).strict();
export const progressRequestSchema = z.object({ leaseToken: z.string().min(16).max(200), message: z.string().min(1).max(10_000) }).strict();
export const reportRequestSchema = z.object({ leaseToken: z.string().min(16).max(200), ok: z.boolean(), result: z.unknown().optional(), error: z.string().max(20_000).optional() }).strict();
export type LeasedJob = { id: string; kind: JobKind; phase: string; leaseToken: string; payload: unknown };
