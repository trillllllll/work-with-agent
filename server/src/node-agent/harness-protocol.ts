import { z } from 'zod';

export const HARNESS_FEATURE = 'harness_sessions_v1';
export const HARNESS_TIMELINE_FEATURE = 'harness_timeline_v1';
export const HARNESS_LIBRARY_FEATURE = 'harness_library_v1';
export const HARNESS_SETTINGS_FEATURE = 'harness_settings_v1';
export const HARNESS_PERMISSIONS_FEATURE = 'harness_permissions_v1';
export const HARNESS_ADVANCED_PERMISSIONS_FEATURE = 'harness_advanced_permissions_v1';
export const HARNESS_WORKSPACE_FEATURE = 'harness_workspace_v1';
export const HARNESS_LARGE_IMAGES_FEATURE = 'harness_large_images_v1';
export const HARNESS_ZCODE_LIVE_FEATURE = 'harness_zcode_live_v1';
export const HARNESS_ZCODE_CREATE_FEATURE = 'harness_zcode_create_v1';
export const HARNESS_ORGANIZATION_FEATURE = 'harness_organization_v1';
export const HARNESS_MESSAGE_ORIGIN_FEATURE = 'harness_message_origin_v1';
/** Negotiated before the executor reports the `dsh` kind, so older servers never parse a kind they reject. */
export const HARNESS_DSH_FEATURE = 'harness_dsh_v1';
export const HARNESS_MODELS = 500;
export const HARNESS_LIBRARY_LEASES = 12;
export const HARNESS_LIBRARY_READS = 6;
export const HARNESS_MESSAGES = 40;
export const HARNESS_TEXT_LIMIT = 24_000;
export const HARNESS_EVENTS = 128;
export const HARNESS_TOOLS = 64;
export const HARNESS_OUTPUT_LIMIT = 4_096;
export const HARNESS_ARTIFACTS = 4;
export const HARNESS_SVG_LIMIT = 64 * 1024;
export const HARNESS_PREVIEW_FILE_LIMIT = 256 * 1024;
export const HARNESS_TEXT_FILE_LIMIT = 256 * 1024;
export const HARNESS_LEGACY_IMAGE_LIMIT = 256 * 1024;
export const HARNESS_IMAGE_FILE_LIMIT = 2 * 1024 * 1024;
export const HARNESS_MESSAGE_IMAGE_LIMIT = 4 * 1024 * 1024;
export const HARNESS_ATTACHMENT_LIMIT = 2;
export const HARNESS_ATTACHMENT_TEXT_PREFIX = '[Dovun 附件] ';

const id = z.string().min(1).max(200);
const cwd = z.string().min(1).max(4096);
const cursor = z.string().min(1).max(4096).nullable();
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const epoch = sequence.min(1);
const text = z.string().max(HARNESS_TEXT_LIMIT);
const input = z.string().trim().min(1).max(HARNESS_TEXT_LIMIT);
export function imageAttachmentBytes(content: string) {
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
  return Math.floor((content.length - padding) * 3 / 4);
}

const attachment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('projectFile'), path: z.string().min(1).max(4_096), name: z.string().min(1).max(255) }).strict(),
  z.object({ kind: z.literal('textFile'), name: z.string().min(1).max(255), content: z.string().max(HARNESS_TEXT_LIMIT) }).strict(),
  z.object({ kind: z.literal('imageFile'), name: z.string().min(1).max(255), mediaType: z.enum(['image/png', 'image/jpeg']),
    content: z.string().max(Math.ceil(HARNESS_IMAGE_FILE_LIMIT / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .refine((content) => imageAttachmentBytes(content) <= HARNESS_IMAGE_FILE_LIMIT),
  }).strict(),
]);
const attachments = z.array(attachment).min(1).max(HARNESS_ATTACHMENT_LIMIT)
  .refine((files) => files.reduce((bytes, file) => bytes + (file.kind === 'imageFile' ? imageAttachmentBytes(file.content) : 0), 0)
    <= HARNESS_MESSAGE_IMAGE_LIMIT).optional();
export type HarnessInputAttachment = z.infer<typeof attachment>;
export const harnessKind = z.enum(['codex', 'claude', 'zcode', 'opencode', 'grok', 'dsh']);
export type HarnessKind = z.infer<typeof harnessKind>;
export const harnessNames: Record<HarnessKind, string> = { codex: 'Codex', claude: 'Claude Code', zcode: 'ZCode', opencode: 'OpenCode', grok: 'Grok', dsh: 'DSH' };
export const codexApprovalPolicy = z.enum(['on-request', 'untrusted', 'never']);
export const claudePermissionMode = z.enum(['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions']);
export const zcodePermissionMode = z.enum(['build', 'edit', 'guarded', 'yolo']);
// Grok exposes ask / auto-review / always-approve over ACP; its plan runs as a session mode, not a permission mode.
export const grokPermissionMode = z.enum(['default', 'auto', 'bypassPermissions']);
const permissionMode = z.union([claudePermissionMode, zcodePermissionMode, grokPermissionMode]);
const sandboxChoice = z.enum(['readOnly', 'workspace', 'fullAccess']);
export const harnessCreateSchema = z.object({ nodeId: id, locationId: id, commandId: id, harness: harnessKind.optional() }).strict();
export const harnessCatalogQuerySchema = z.object({ nodeId: id, locationId: id, cursor: cursor.optional(), harness: harnessKind.optional() }).strict();
export const harnessOpenThreadSchema = z.object({ nodeId: id, locationId: id, threadId: id, harness: harnessKind.optional() }).strict();
export const harnessHistoryQuerySchema = z.object({ cursor: cursor.optional() }).strict();
export const harnessIndexQuerySchema = z.object({ nodeId: id, cursor: cursor.optional(), harness: harnessKind.optional(), archived: z.boolean().optional() }).strict();
export const harnessMetadataSchema = z.object({
  title: z.string().trim().min(1).max(160).nullable().optional(),
  pinned: z.boolean().optional(), archived: z.boolean().optional(), read: z.boolean().optional(),
}).strict();
export const harnessFilesQuerySchema = z.object({
  path: z.string().max(4096).default(''), preview: z.boolean().default(false),
}).strict();
const commandId = { commandId: id, expectedEpoch: epoch };
const turnId = { turnId: id };

const settingsFields = {
  model: id, effort: id.nullable(), mode: z.enum(['default', 'plan']), permission: sandboxChoice,
  permissionMode: permissionMode.optional(), approvalPolicy: codexApprovalPolicy.optional(),
};
const settingsChange = z.object(settingsFields).strict().partial();
const settingsSelection = z.object({ ...settingsFields, revision: sequence }).strict();
const modelOption = z.object({
  id, label: z.string().min(1).max(200), defaultEffort: id.nullable(),
  efforts: z.array(id).max(32),
}).strict();
const settingsView = settingsSelection.extend({
  models: z.array(modelOption).max(HARNESS_MODELS), planAvailable: z.boolean(), catalogAvailable: z.boolean(),
  provider: id.optional(), providers: z.array(id).max(50).optional(),
  permissionModes: z.array(permissionMode).max(8).optional(),
  approvalPolicies: z.array(codexApprovalPolicy).max(3).optional(),
  sandboxChoices: z.array(sandboxChoice).max(3).optional(),
});
const queueItem = z.object({
  id, text: input, settings: settingsSelection.optional(), status: z.enum(['queued', 'starting', 'blocked']),
  error: z.string().max(500).optional(),
  attachmentNames: z.array(z.string().max(255)).max(2).optional(),
}).strict();
const queueView = z.object({ revision: sequence, items: z.array(queueItem).max(12) }).strict();
const queueTarget = { ...commandId, itemId: id, expectedQueueRevision: sequence };
const question = z.object({
  id, label: z.string().min(1).max(2_000), options: z.array(z.object({
    label: z.string().min(1).max(512), description: z.string().max(1_000),
  }).strict()).max(12), freeText: z.boolean(),
}).strict();
const approvalDecision = z.enum(['accept', 'acceptForSession', 'decline', 'cancel']);
const plan = z.object({
  turnId: id, text: z.string().max(HARNESS_TEXT_LIMIT), ready: z.boolean(),
  steps: z.array(z.object({ text: z.string().min(1).max(1_000), status: z.enum(['pending', 'inProgress', 'completed']) }).strict()).max(30),
}).strict();
const usage = z.object({ used: sequence, total: sequence, limit: sequence.nullable() }).strict();

export const HARNESS_WORKSPACE_OPERATIONS = ['enqueue', 'editQueued', 'moveQueued', 'removeQueued', 'sendQueuedNow',
  'answerQuestion', 'compact', 'approvePlan', 'fork', 'rerun'] as const;
export const harnessCommandSchema = z.discriminatedUnion('operation', [
  z.object({ ...commandId, operation: z.literal('send'), text: input, attachments, expectedSettingsRevision: sequence.optional() }).strict(),
  z.object({ ...commandId, operation: z.literal('configure'), expectedSettingsRevision: sequence, changes: settingsChange }).strict(),
  z.object({ ...commandId, ...turnId, operation: z.literal('steer'), text: input, attachments }).strict(),
  z.object({ ...commandId, ...turnId, operation: z.literal('interrupt') }).strict(),
  z.object({ ...commandId, operation: z.literal('resolveApproval'), requestId: id, decision: approvalDecision }).strict(),
  z.object({ ...commandId, operation: z.literal('choosePermission'), requestId: id, optionId: id }).strict(),
  z.object({ ...commandId, operation: z.literal('enqueue'), text: input, attachments, expectedSettingsRevision: sequence.optional() }).strict(),
  z.object({ ...queueTarget, operation: z.literal('editQueued'), text: input }).strict(),
  z.object({ ...queueTarget, operation: z.literal('moveQueued'), direction: z.enum(['up', 'down']) }).strict(),
  z.object({ ...queueTarget, operation: z.literal('removeQueued') }).strict(),
  z.object({ ...queueTarget, operation: z.literal('sendQueuedNow') }).strict(),
  z.object({ ...commandId, operation: z.literal('answerQuestion'), requestId: id,
    answers: z.array(z.object({ id, value: z.string().trim().min(1).max(2_000) }).strict()).min(1).max(8),
  }).strict(),
  z.object({ ...commandId, operation: z.literal('compact') }).strict(),
  z.object({ ...commandId, ...turnId, operation: z.literal('approvePlan'), expectedSettingsRevision: sequence }).strict(),
  z.object({ ...commandId, operation: z.literal('fork'), turnId: id.optional(), modelProvider: id.optional() }).strict(),
  z.object({ ...commandId, ...turnId, operation: z.literal('rerun'), text: input.optional(), expectedSettingsRevision: sequence.optional() }).strict(),
]);
export const harnessStartSchema = z.object({ commandId: id, operation: z.literal('start'), cwd }).strict();
const intent = z.union([harnessStartSchema, harnessCommandSchema]);
export const harnessDeliverySchema = z.object({
  sessionId: id, command: intent, expiresAt: z.string().datetime(),
}).strict();

export const harnessReadTaskSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('index'), id, cursor, harness: harnessKind.optional(), organization: z.literal(true).optional(),
    archived: z.literal(true).optional(), recheckThreadIds: z.array(id).max(30).optional() }).strict(),
  z.object({ kind: z.literal('files'), id, cwd, ...harnessFilesQuerySchema.shape }).strict(),
  z.object({ kind: z.literal('catalog'), id, cwd, cursor, harness: harnessKind.optional(), organization: z.literal(true).optional() }).strict(),
  z.object({ kind: z.literal('thread'), id, cwd, threadId: id, harness: harnessKind.optional(), organization: z.literal(true).optional() }).strict(),
  z.object({ kind: z.literal('history'), id, cwd, threadId: id, cursor, harness: harnessKind.optional() }).strict(),
]);

export const harnessLeaseSchema = z.object({
  sessionId: id,
  threadId: id.nullable(),
  epoch: sequence,
  snapshotRequested: z.boolean(),
  commands: z.array(harnessDeliverySchema).max(32),
}).strict();
export const harnessLibraryLeaseSchema = harnessLeaseSchema.extend({ library: z.boolean(), nativeCwd: cwd.optional(), harness: harnessKind.optional() });

export const harnessMessagePhase = z.enum(['commentary', 'partial_answer', 'final_answer']);
const message = z.object({
  id, turnId: id, role: z.enum(['user', 'assistant']), text,
  clientCommandId: id.optional(),
  phase: harnessMessagePhase.optional(), order: sequence.optional(), streaming: z.boolean().optional(),
  attachmentNames: z.array(z.string().min(1).max(255)).max(2).optional(),
}).strict();
const turn = z.object({ id, status: z.enum(['inProgress', 'completed', 'failed', 'interrupted', 'unknown']), error: z.string().max(500).optional() }).strict();
const tool = z.object({
  id, turnId: id, order: sequence.optional(),
  kind: z.enum(['command', 'fileChange', 'webSearch', 'tool', 'image']),
  status: z.enum(['running', 'completed', 'failed', 'interrupted', 'unknown']),
  title: z.string().max(1_000), output: z.string().max(HARNESS_OUTPUT_LIMIT).optional(),
  truncated: z.boolean().optional(), exitCode: z.number().int().optional(),
  files: z.array(z.string().max(600)).max(8).optional(),
  diffs: z.array(z.object({
    path: z.string().max(600), added: sequence, removed: sequence, patch: z.string().max(1500), truncated: z.boolean(),
  }).strict()).max(8).optional(),
}).strict();
const artifact = z.object({
  id, turnId: id, messageId: id, kind: z.literal('svg'), name: z.string().min(1).max(255),
  href: z.string().min(1).max(4_096), source: z.string().min(1).max(HARNESS_SVG_LIMIT),
}).strict();
const approval = z.object({
  id, turnId: id, kind: z.enum(['command', 'fileChange', 'permissions', 'question', 'plan']),
  details: text, canAccept: z.boolean(),
  questions: z.array(question).min(1).max(8).optional(),
  decisions: z.array(approvalDecision).max(4).optional(),
  options: z.array(z.object({ id, scope: z.enum(['once', 'session', 'project', 'projectComputerUse', 'approvePlan', 'deny']) }).strict()).min(1).max(4).optional(),
}).strict();
const state = z.object({
  messages: z.array(message).max(HARNESS_MESSAGES), turn: turn.nullable(),
  approvals: z.array(approval).max(32), error: z.string().max(500).nullable(),
  turns: z.array(turn).max(HARNESS_MESSAGES).optional(),
  tools: z.array(tool).max(HARNESS_TOOLS).optional(),
  artifacts: z.array(artifact).max(HARNESS_ARTIFACTS).optional(),
  settings: settingsView.optional(),
  queue: queueView.optional(),
  plan: plan.optional(),
  usage: usage.optional(),
}).strict();
const nativeOrder = z.number().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
export const harnessOrganizationSchema = z.object({
  pinned: z.boolean().optional(), pinOrder: nativeOrder.nullable().optional(), archived: z.boolean().optional(),
  group: z.object({ id, name: z.string().min(1).max(255), order: nativeOrder.optional(), memberOrder: nativeOrder.optional() }).strict().nullable().optional(),
  tag: z.string().min(1).max(255).nullable().optional(),
}).strict();
export const harnessProjectPinsSchema = z.array(z.object({ cwd, order: nativeOrder }).strict()).max(200);
export const harnessCatalogThreadSchema = z.object({
  threadId: id, title: z.string().max(160), updatedAt: z.string().datetime(), organization: harnessOrganizationSchema.optional(),
}).strict();
const harnessIndexThreadSchema = harnessCatalogThreadSchema.extend({ cwd, name: z.string().min(1).max(255) });
export const harnessCatalogPageSchema = z.object({ threads: z.array(harnessCatalogThreadSchema).max(30), nextCursor: cursor }).strict();
export const harnessIndexPageSchema = harnessCatalogPageSchema.extend({
  threads: z.array(harnessIndexThreadSchema).max(30),
  priorityThreads: z.array(harnessIndexThreadSchema).max(60).optional(),
  projectPins: harnessProjectPinsSchema.optional(),
});
export const harnessFilesPageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('directory'), path: z.string().max(4096),
    entries: z.array(z.object({ name: z.string().min(1).max(255), path: cwd, directory: z.boolean() }).strict()).max(200),
    limited: z.boolean(),
  }).strict(),
  z.object({ kind: z.literal('file'), path: cwd, content: z.string().max(360_000), mediaType: z.enum(['text/plain', 'image/png', 'image/jpeg']) }).strict(),
]);
export const harnessHistoryPageSchema = z.object({
  view: state.extend({ messages: z.array(message), turn: z.null() }), nextCursor: cursor,
}).strict();
export const harnessReadResultSchemas = {
  index: harnessIndexPageSchema, files: harnessFilesPageSchema, catalog: harnessCatalogPageSchema, thread: harnessCatalogThreadSchema, history: harnessHistoryPageSchema,
};
export const harnessReadErrorSchema = z.object({ error: z.string().min(1).max(500) }).strict();
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
  z.object({ kind: z.literal('settings'), settings: settingsView }).strict(),
  z.object({ kind: z.literal('queue'), queue: queueView }).strict(),
  z.object({ kind: z.literal('plan'), plan }).strict(),
  z.object({ kind: z.literal('usage'), usage }).strict(),
]);

export const harnessSyncSchema = z.discriminatedUnion('type', [
  harnessSnapshotSchema,
  z.object({ type: z.literal('events'), epoch, events: z.array(z.object({ seq: sequence.min(1), event: harnessEventSchema }).strict()).min(1).max(32) }).strict(),
  z.object({ type: z.literal('unavailable'), epoch, error: z.string().min(1).max(500) }).strict(),
  z.object({ type: z.literal('receipt'), commandId: id, status: z.enum(['accepted', 'rejected', 'unknown', 'expired']), error: z.string().max(500).optional(),
    forkedThreadId: id.optional(),
  }).strict(),
]);

export type HarnessCommand = z.infer<typeof harnessCommandSchema>;
export type HarnessSettingsChange = z.infer<typeof settingsChange>;
export type HarnessSettingsSelection = z.infer<typeof settingsSelection>;
export type HarnessSettingsView = z.infer<typeof settingsView>;
export type HarnessModelOption = z.infer<typeof modelOption>;
export type HarnessDelivery = z.infer<typeof harnessDeliverySchema>;
export type HarnessLease = z.infer<typeof harnessLeaseSchema>;
export type HarnessLibraryLease = z.infer<typeof harnessLibraryLeaseSchema>;
export type HarnessReadTask = z.infer<typeof harnessReadTaskSchema>;
export type HarnessCatalogThread = z.infer<typeof harnessCatalogThreadSchema>;
export type HarnessOrganization = z.infer<typeof harnessOrganizationSchema>;
export type HarnessProjectPins = z.infer<typeof harnessProjectPinsSchema>;
export type HarnessCatalogPage = z.infer<typeof harnessCatalogPageSchema>;
export type HarnessHistoryPage = z.infer<typeof harnessHistoryPageSchema>;
export type HarnessFilesPage = z.infer<typeof harnessFilesPageSchema>;
export type HarnessSnapshot = z.infer<typeof harnessSnapshotSchema>;
export type HarnessEvent = z.infer<typeof harnessEventSchema>;
export type HarnessSync = z.infer<typeof harnessSyncSchema>;
export type HarnessView = z.infer<typeof state>;
export type HarnessMessage = z.infer<typeof message>;
export type HarnessTurn = z.infer<typeof turn>;
export type HarnessTool = z.infer<typeof tool>;
export type HarnessArtifact = z.infer<typeof artifact>;
export type HarnessApproval = z.infer<typeof approval>;
export type HarnessQueue = z.infer<typeof queueView>;
export type HarnessQueueItem = z.infer<typeof queueItem>;
export type HarnessReceipt = Extract<HarnessSync, { type: 'receipt' }>;

function withoutMessageOrigin({ clientCommandId: _origin, ...message }: HarnessMessage) { return message; }

export function withoutHarnessMessageOrigins(view: HarnessView): HarnessView {
  return { ...view, messages: view.messages.map(withoutMessageOrigin) };
}

export function withoutHarnessSyncMessageOrigins(sync: HarnessSync): HarnessSync {
  if (sync.type === 'snapshot') return { ...sync, view: withoutHarnessMessageOrigins(sync.view) };
  if (sync.type !== 'events') return sync;
  return { ...sync, events: sync.events.map((entry) => entry.event.kind === 'message'
    ? { ...entry, event: { ...entry.event, message: withoutMessageOrigin(entry.event.message) } }
    : entry) };
}
export function requiresHarnessWorkspace(command: HarnessCommand) {
  return HARNESS_WORKSPACE_OPERATIONS.some((operation) => operation === command.operation)
    || ('attachments' in command && Boolean(command.attachments?.length))
    || (command.operation === 'resolveApproval' && (command.decision === 'acceptForSession' || command.decision === 'cancel'));
}

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
  if (event.kind === 'tool' || event.kind === 'toolOutput' || event.kind === 'artifact' || event.kind === 'settings') return null;
  if (event.kind !== 'message') return event;
  const { id, turnId, role, text } = event.message;
  return { kind: 'message', message: { id, turnId, role, text } };
}

export function legacyHarnessSnapshot(snapshot: HarnessSnapshot): HarnessSnapshot {
  const { messages, turn, approvals, error } = snapshot.view;
  return { ...snapshot, view: { messages: messages.map(({ id, turnId, role, text }) => ({ id, turnId, role, text })), turn, approvals, error } };
}

function legacyPermissionSettings<T extends HarnessSettingsSelection>(settings: T) {
  const { permissionMode: _mode, approvalPolicy: _policy, ...legacy } = settings;
  return legacy;
}

export function requiresAdvancedPermissions(settings?: HarnessSettingsChange) {
  return settings?.permission === 'fullAccess' || settings?.permissionMode === 'auto' || settings?.permissionMode === 'bypassPermissions';
}

function projectPermissionSettings(settings: HarnessSettingsView, permissions: boolean, advanced: boolean): HarnessSettingsView | undefined {
  if (!advanced && requiresAdvancedPermissions(settings)) return;
  if (permissions) return advanced ? settings : {
    ...settings,
    permissionModes: settings.permissionModes?.filter((permissionMode) => !requiresAdvancedPermissions({ permissionMode })),
    sandboxChoices: settings.sandboxChoices?.filter((permission) => !requiresAdvancedPermissions({ permission })),
  };
  const { permissionModes: _modes, approvalPolicies: _policies, sandboxChoices: _sandboxes, ...legacy } = settings;
  return legacyPermissionSettings(legacy);
}

function projectQueuePermissions(queue: HarnessQueue, permissions: boolean, advanced: boolean): HarnessQueue {
  if (permissions && advanced) return queue;
  return { ...queue, items: queue.items.map(({ settings, ...item }) => ({ ...item,
    ...(settings && !requiresAdvancedPermissions(settings) ? { settings: permissions ? settings : legacyPermissionSettings(settings) } : {}),
  })) };
}

export function harnessEventForClient(event: HarnessEvent, timeline: boolean, settings: boolean, workspace = false, permissions = false, advanced = false): HarnessEvent | null {
  if (event.kind === 'approval' && event.approval.options && !permissions) return null;
  if (event.kind === 'queue') return workspace ? { ...event, queue: projectQueuePermissions(event.queue, permissions, advanced) } : null;
  if (event.kind === 'plan' || event.kind === 'usage' || event.kind === 'approval' && event.approval.kind === 'question') {
    return workspace ? event : null;
  }
  if (event.kind === 'settings') {
    const projected = settings && projectPermissionSettings(event.settings, permissions, advanced);
    return projected ? { ...event, settings: projected } : null;
  }
  if (!workspace && event.kind === 'message' && event.message.attachmentNames) {
    const { attachmentNames: _attachments, ...message } = event.message;
    return timeline ? { kind: 'message', message } : legacyHarnessEvent(event);
  }
  if (!workspace && event.kind === 'tool' && event.tool.diffs) {
    const { diffs: _diffs, ...tool } = event.tool;
    return timeline ? { kind: 'tool', tool } : null;
  }
  if (!workspace && event.kind === 'approval' && event.approval.decisions) {
    const { decisions: _decisions, ...approval } = event.approval;
    return { kind: 'approval', approval };
  }
  return timeline ? event : legacyHarnessEvent(event);
}

export function harnessSnapshotForClient(snapshot: HarnessSnapshot, timeline: boolean, settings: boolean, workspace = false, permissions = false, advanced = false): HarnessSnapshot {
  if (!workspace) {
    const { queue: _queue, plan: _plan, usage: _usage, ...rest } = snapshot.view;
    snapshot = { ...snapshot, view: { ...rest, approvals: rest.approvals.filter((item) => item.kind !== 'question').map(({ decisions: _decisions, ...item }) => item),
      messages: rest.messages.map(({ attachmentNames: _attachments, ...message }) => message),
      ...(rest.tools ? { tools: rest.tools.map(({ diffs: _diffs, ...tool }) => tool) } : {}),
    } };
  }
  const projected = timeline ? snapshot : legacyHarnessSnapshot(snapshot);
  const { settings: _settings, ...view } = projected.view;
  const selection = settings && snapshot.view.settings && projectPermissionSettings(snapshot.view.settings, permissions, advanced);
  return { ...projected, view: { ...view,
    approvals: permissions ? view.approvals : view.approvals.filter((item) => !item.options),
    ...(view.queue ? { queue: projectQueuePermissions(view.queue, permissions, advanced) } : {}),
    ...(selection ? { settings: selection } : {}),
  } };
}

export function requiresNativePermissionSettings(changes: HarnessSettingsChange) {
  return changes.permissionMode !== undefined || changes.approvalPolicy !== undefined || changes.permission === 'fullAccess';
}

export function applyHarnessEvent(view: HarnessView, event: HarnessEvent): HarnessView {
  switch (event.kind) {
    case 'settings':
      return { ...view, settings: event.settings };
    case 'queue':
      return { ...view, queue: event.queue };
    case 'plan':
      return { ...view, plan: event.plan };
    case 'usage':
      return { ...view, usage: event.usage };
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
