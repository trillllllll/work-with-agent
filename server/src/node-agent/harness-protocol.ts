import { z } from 'zod';

export const HARNESS_FEATURE = 'harness_sessions_v1';
export const HARNESS_MESSAGES = 40;
export const HARNESS_TEXT_LIMIT = 24_000;
export const HARNESS_EVENTS = 128;

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

const message = z.object({ id, turnId: id, role: z.enum(['user', 'assistant']), text }).strict();
const turn = z.object({ id, status: z.enum(['inProgress', 'completed', 'failed', 'interrupted', 'unknown']), error: z.string().max(500).optional() }).strict();
const approval = z.object({
  id, turnId: id, kind: z.enum(['command', 'fileChange', 'permissions']),
  details: z.string().max(8_000), canAccept: z.boolean(),
}).strict();
const state = z.object({
  messages: z.array(message).max(HARNESS_MESSAGES), turn: turn.nullable(),
  approvals: z.array(approval).max(32), error: z.string().max(500).nullable(),
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
export type HarnessApproval = z.infer<typeof approval>;
export type HarnessReceipt = Extract<HarnessSync, { type: 'receipt' }>;

export function applyHarnessEvent(view: HarnessView, event: HarnessEvent): HarnessView {
  switch (event.kind) {
    case 'turn':
      return { ...view, turn: event.turn, approvals: event.turn.status === 'inProgress' ? view.approvals.filter((item) => item.turnId === event.turn.id) : [], error: null };
    case 'approval':
      return { ...view, approvals: [...view.approvals.filter((item) => item.id !== event.approval.id), event.approval].slice(-32) };
    case 'approvalResolved':
      return { ...view, approvals: view.approvals.filter((item) => item.id !== event.id) };
    case 'message': {
      const messages = view.messages.some((item) => item.id === event.message.id)
        ? view.messages.map((item) => item.id === event.message.id ? event.message : item)
        : [...view.messages, event.message];
      return { ...view, messages: messages.slice(-HARNESS_MESSAGES) };
    }
    case 'delta': {
      const item = view.messages.find((message) => message.id === event.id);
      return applyHarnessEvent(view, { kind: 'message', message: {
        id: event.id, turnId: event.turnId, role: 'assistant',
        text: ((item?.text ?? '') + event.delta).slice(0, HARNESS_TEXT_LIMIT),
      } });
    }
  }
}
