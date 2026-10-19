/** Wire contract between the WWA server and a local executor (wwa-node). Shared by both sides. */
import { z } from 'zod';
import { permissionsSchema, providerSchema, resultSchema } from '../runner/contracts.js';

export const NODE_PROTOCOL_VERSION = 1;
/** A node that has not leased for this long is shown offline. */
export const NODE_ONLINE_MS = 90_000;
/** Leases renew on every heartbeat; an expired lease turns the job `lost`. */
export const JOB_LEASE_MS = 15 * 60_000;

const relPath = z.string().min(1).max(4096);
export const probePayloadSchema = z.object({ path: relPath }).strict();
export const preparePayloadSchema = z.object({ repoPath: relPath, branch: z.string().min(1).max(250), startPoint: z.string().min(1).max(250), worktreeName: z.string().min(1).max(200) }).strict();
export const runPayloadSchema = z.object({
  repoPath: relPath,
  provider: providerSchema,
  permissions: permissionsSchema,
  /** Grant git metadata writes (commit / merge) inside the worktree. */
  gitWrite: z.boolean().default(false),
  /** Either reuse an existing worktree path reported earlier by this node, or create one. */
  worktree: z.union([
    z.object({ existing: relPath }).strict(),
    z.object({ create: z.object({ branch: z.string().min(1).max(250), startPoint: z.string().min(1).max(250), worktreeName: z.string().min(1).max(200) }).strict() }).strict(),
  ]),
  prompt: z.string().min(1).max(400_000),
  /** Facts the node computes after the run, independent of the AI's own claims. */
  expect: z.object({ includes: z.array(z.string().regex(/^[0-9a-f]{7,64}$/)).max(50).default([]), base: z.string().max(64).optional(), branch: z.string().max(250).optional() }).strict().default({}),
}).strict();
export const pushPayloadSchema = z.object({ worktree: relPath, branch: z.string().min(1).max(250), remote: z.string().min(1).max(100).default('origin') }).strict();
export type ProbePayload = z.infer<typeof probePayloadSchema>;
export type PreparePayload = z.infer<typeof preparePayloadSchema>;
export type RunPayload = z.infer<typeof runPayloadSchema>;
export type PushPayload = z.infer<typeof pushPayloadSchema>;

export const jobKindSchema = z.enum(['probe', 'prepare', 'run', 'push']);
export type JobKind = z.infer<typeof jobKindSchema>;

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
}).strict();
export type GitFacts = z.infer<typeof gitFactsSchema>;

export const probeResultSchema = z.object({ toplevel: z.string().max(4096), rootCommit: z.string().max(64).nullable(), originUrl: z.string().max(2000).nullable(), branches: z.array(z.string().max(250)).max(500), head: z.string().max(64).nullable(), dirtyCount: z.number().int().min(0) }).strict();
export const prepareResultSchema = z.object({ worktree: z.string().max(4096), branch: z.string().max(250), head: z.string().max(64), replay: z.boolean().default(false), dirtyCount: z.number().int().min(0).default(0) }).strict();
export const runResultSchema = z.object({ worktree: z.string().max(4096), sessionId: z.string().max(200).nullable().default(null), result: resultSchema.nullable(), error: z.string().max(20_000).nullable().default(null), stderrTail: z.string().max(20_000).default(''), facts: gitFactsSchema.nullable(), preHead: z.string().max(64).nullable().default(null) }).strict();
export const pushResultSchema = z.object({ output: z.string().max(20_000), head: z.string().max(64).nullable() }).strict();

export const capabilitiesSchema = z.object({
  protocol: z.number().int(),
  version: z.string().max(100).default(''),
  platform: z.string().max(100).default(''),
  providers: z.array(z.object({ provider: providerSchema, available: z.boolean(), version: z.string().max(200).default('') })).max(10).default([]),
  maxConcurrent: z.number().int().min(1).max(4).default(2),
  allowedRoots: z.array(z.string().max(4096)).max(50).default([]),
  freeBytes: z.number().nonnegative().nullable().default(null),
}).strict();
export type NodeCapabilities = z.infer<typeof capabilitiesSchema>;

export const leaseRequestSchema = z.object({ capabilities: capabilitiesSchema, activeJobIds: z.array(z.string().min(1).max(100)).max(50).default([]), max: z.number().int().min(0).max(4).default(1) }).strict();
export const progressRequestSchema = z.object({ leaseToken: z.string().min(16).max(200), message: z.string().min(1).max(10_000) }).strict();
export const reportRequestSchema = z.object({ leaseToken: z.string().min(16).max(200), ok: z.boolean(), result: z.unknown().optional(), error: z.string().max(20_000).optional() }).strict();
export type LeasedJob = { id: string; kind: JobKind; phase: string; leaseToken: string; payload: unknown };
