import { z } from 'zod';

export const HARNESS_FEATURE = 'harness_sessions_v1';
export const HARNESS_TIMELINE_FEATURE = 'harness_timeline_v1';
export const HARNESS_MESSAGES = 40;
export const HARNESS_TEXT_LIMIT = 24_000;
export const HARNESS_EVENTS = 128;
export const HARNESS_TOOLS = 64;
export const HARNESS_OUTPUT_LIMIT = 4_096;
export const HARNESS_ARTIFACTS = 4;
export const HARNESS_SVG_LIMIT = 64 * 1024;

const id = z.string().min(1).max(200);
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const epoch = sequence.min(1);
const text = z.string().max(HARNESS_TEXT_LIMIT);
const input = z.string().trim().min(1).max(HARNESS_TEXT_LIMIT);
export const harnessCreateSchema = z.object({ nodeId: id, locationId: id, commandId: id }).strict();
const commandId = { commandId: id, expectedEpoch: epoch };
const turnId = { turnId: id };

export const harnessCommandSchema = z.discriminatedUnion('operation', [
  z.object({ ...commandId, operation: z.literal('send'), text: input }).strict(),
  z.object({ ...commandId, ...turnId, operation: z.literal('steer'), text: input }).strict(),
  z.object({ ...commandId, ...turnId, operation: z.literal('interrupt') }).strict(),
  z.object({ ...commandId, operation: z.literal('resolveApproval'), requestId: id, decision: z.enum(['accept', 'decline']) }).strict(),
]);
const startSchema = z.object({ commandId: id, operation: z.literal('start'), cwd: z.string().min(1).max(4096) }).strict();
const intent = z.union([startSchema, harnessCommandSchema]);
export const harnessDeliverySchema = z.object({
  sessionId: id, command: intent, expiresAt: z.string().datetime(),
}).strict();

export const harnessLeaseSchema = z.object({
  sessionId: id,
  threadId: id.nullable(),
  epoch: sequence,
  snapshotRequested: z.boolean(),
  commands: z.array(harnessDeliverySchema).max(32),
}).strict();

export const harnessMessagePhase = z.enum(['commentary', 'partial_answer', 'final_answer']);
const message = z.object({
  id, turnId: id, role: z.enum(['user', 'assistant']), text,
  phase: harnessMessagePhase.optional(), order: sequence.optional(), streaming: z.boolean().optional(),
}).strict();
const turn = z.object({ id, status: z.enum(['inProgress', 'completed', 'failed', 'interrupted', 'unknown']), error: z.string().max(500).optional() }).strict();
const tool = z.object({
  id, turnId: id, order: sequence.optional(),
  kind: z.enum(['command', 'fileChange', 'webSearch', 'tool', 'image']),
  status: z.enum(['running', 'completed', 'failed', 'interrupted', 'unknown']),
  title: z.string().max(1_000), output: z.string().max(HARNESS_OUTPUT_LIMIT).optional(),
  truncated: z.boolean().optional(), exitCode: z.number().int().optional(),
  files: z.array(z.string().max(600)).max(8).optional(),
}).strict();
const artifact = z.object({
  id, turnId: id, messageId: id, kind: z.literal('svg'), name: z.string().min(1).max(255),
  href: z.string().min(1).max(4_096), source: z.string().min(1).max(HARNESS_SVG_LIMIT),
}).strict();
const approval = z.object({
  id, turnId: id, kind: z.enum(['command', 'fileChange', 'permissions']),
  details: z.string().max(8_000), canAccept: z.boolean(),
}).strict();
const state = z.object({
  messages: z.array(message).max(HARNESS_MESSAGES), turn: turn.nullable(),
  approvals: z.array(approval).max(32), error: z.string().max(500).nullable(),
  turns: z.array(turn).max(HARNESS_MESSAGES).optional(),
  tools: z.array(tool).max(HARNESS_TOOLS).optional(),
  artifacts: z.array(artifact).max(HARNESS_ARTIFACTS).optional(),
}).strict();
export const harnessSnapshotSchema = z.object({
  type: z.literal('snapshot'), threadId: id, epoch, seq: sequence, view: state,
}).strict();

export const harnessEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), message }).strict(),
  z.object({ kind: z.literal('delta'), id, turnId: id, delta: text }).strict(),
  z.object({ kind: z.literal('turn'), turn }).strict(),
  z.object({ kind: z.literal('approval'), approval }).strict(),
  z.object({ kind: z.literal('approvalResolved'), id }).strict(),
  z.object({ kind: z.literal('tool'), tool }).strict(),
  z.object({ kind: z.literal('toolOutput'), turnId: id, id, delta: z.string().max(HARNESS_OUTPUT_LIMIT), truncated: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('artifact'), artifact }).strict(),
]);

export const harnessSyncSchema = z.discriminatedUnion('type', [
  harnessSnapshotSchema,
  z.object({ type: z.literal('events'), epoch, events: z.array(z.object({ seq: sequence.min(1), event: harnessEventSchema }).strict()).min(1).max(32) }).strict(),
  z.object({ type: z.literal('unavailable'), epoch, error: z.string().min(1).max(500) }).strict(),
  z.object({ type: z.literal('receipt'), commandId: id, status: z.enum(['accepted', 'rejected', 'unknown', 'expired']), error: z.string().max(500).optional() }).strict(),
]);

export type HarnessCommand = z.infer<typeof harnessCommandSchema>;
export type HarnessDelivery = z.infer<typeof harnessDeliverySchema>;
export type HarnessLease = z.infer<typeof harnessLeaseSchema>;
export type HarnessSnapshot = z.infer<typeof harnessSnapshotSchema>;
export type HarnessEvent = z.infer<typeof harnessEventSchema>;
export type HarnessSync = z.infer<typeof harnessSyncSchema>;
export type HarnessView = z.infer<typeof state>;
export type HarnessMessage = z.infer<typeof message>;
export type HarnessTurn = z.infer<typeof turn>;
export type HarnessTool = z.infer<typeof tool>;
export type HarnessArtifact = z.infer<typeof artifact>;
export type HarnessApproval = z.infer<typeof approval>;
export type HarnessReceipt = Extract<HarnessSync, { type: 'receipt' }>;

function upsert<T extends { id: string }>(rows: readonly T[], row: T, limit: number): T[] {
  return rows.some((item) => item.id === row.id)
    ? rows.map((item) => item.id === row.id ? row : item)
    : [...rows, row].slice(-limit);
}

function nextOrder(view: HarnessView) {
  const tools = view.tools ?? [];
  return Math.max(view.messages[view.messages.length - 1]?.order ?? view.messages.length, tools[tools.length - 1]?.order ?? 0) + 1;
}

export function legacyHarnessEvent(event: HarnessEvent): HarnessEvent | null {
  if (event.kind === 'tool' || event.kind === 'toolOutput' || event.kind === 'artifact') return null;
  if (event.kind !== 'message') return event;
  const { id, turnId, role, text } = event.message;
  return { kind: 'message', message: { id, turnId, role, text } };
}

export function legacyHarnessSnapshot(snapshot: HarnessSnapshot): HarnessSnapshot {
  const { messages, turn, approvals, error } = snapshot.view;
  return { ...snapshot, view: { messages: messages.map(({ id, turnId, role, text }) => ({ id, turnId, role, text })), turn, approvals, error } };
}

export function applyHarnessEvent(view: HarnessView, event: HarnessEvent): HarnessView {
  switch (event.kind) {
    case 'turn': {
      const running = event.turn.status === 'inProgress';
      const tools = running ? view.tools : view.tools?.map((item): HarnessTool =>
        item.turnId === event.turn.id && item.status === 'running'
          ? { ...item, status: event.turn.status === 'interrupted' ? 'interrupted' : 'unknown' }
          : item);
      return { ...view, turn: event.turn, turns: upsert(view.turns ?? [], event.turn, HARNESS_MESSAGES),
        ...(tools ? { tools } : {}), approvals: running ? view.approvals.filter((item) => item.turnId === event.turn.id) : [], error: null };
    }
    case 'approval':
      return { ...view, approvals: [...view.approvals.filter((item) => item.id !== event.approval.id), event.approval].slice(-32) };
    case 'approvalResolved':
      return { ...view, approvals: view.approvals.filter((item) => item.id !== event.id) };
    case 'message': {
      const previous = view.messages.find((item) => item.id === event.message.id);
      return { ...view, messages: upsert(view.messages, {
        ...previous, ...event.message, order: previous?.order ?? nextOrder(view),
      }, HARNESS_MESSAGES) };
    }
    case 'delta': {
      const item = view.messages.find((message) => message.id === event.id);
      return applyHarnessEvent(view, { kind: 'message', message: {
        id: event.id, turnId: event.turnId, role: 'assistant',
        text: ((item?.text ?? '') + event.delta).slice(0, HARNESS_TEXT_LIMIT), streaming: true,
      } });
    }
    case 'tool': {
      const tools = view.tools ?? [];
      const previous = tools.find((item) => item.id === event.tool.id);
      if (previous && previous.status !== 'running' && event.tool.status === 'running') return view;
      return { ...view, tools: upsert(tools, { ...previous, ...event.tool, order: previous?.order ?? nextOrder(view) }, HARNESS_TOOLS) };
    }
    case 'toolOutput': {
      const tools = view.tools ?? [];
      const item = tools.find((tool) => tool.id === event.id && tool.turnId === event.turnId);
      if (!item || item.status !== 'running') return view;
      const output = (item.output ?? '') + event.delta;
      return { ...view, tools: upsert(tools, { ...item, output: output.slice(-HARNESS_OUTPUT_LIMIT),
        truncated: item.truncated || event.truncated || output.length > HARNESS_OUTPUT_LIMIT }, HARNESS_TOOLS) };
    }
    case 'artifact':
      return { ...view, artifacts: upsert(view.artifacts ?? [], event.artifact, HARNESS_ARTIFACTS) };
  }
}
